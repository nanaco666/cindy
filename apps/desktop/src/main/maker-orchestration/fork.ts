/**
 * fork-session：消息级 fork 业务函数。
 *
 * 流程：读 source → 校验 target message (user / assistant) → 计算复制边界与
 *      agent 侧截断信息 → 调 SDK fork → SQLite 事务 insert + bulk copy messages。
 *
 * SDK 调用必须在事务外——SDK 失败时 DB 完全没动；DB 失败时 SDK jsonl 已落盘
 * 变成"孤儿 jsonl"，可接受（数量极少，留给后续清理脚本）。
 */

import { eq, and, lt, gt, gte, asc, isNull, count } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';

import { getDbClient } from '../localDb/client/current';
import { sessions, messages } from '../localDb/schema';
import { sessionToCamel } from '../localDb/mapper';
import { getMaker } from '../maker-host/index.js';
import { createBusinessSessionId } from '../sessionIds.js';
import type { Session } from '../../renderer/lib/ccAgent.types';
import {
  type ClaudeTranscriptAnchorIndex,
  loadClaudeTranscriptAnchorIndex,
  parseClaudeAgentMeta,
  resolveClaudeForkAssistantAnchor,
} from './claudeTranscriptAnchors';

/** fork 内部错误码——由 IPC 层 catch 后映射到对应 IPC 错误码。 */
export type ForkErrorCode =
  | 'SOURCE_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'NOT_USER_MESSAGE'
  | 'NOT_CODEX_SESSION'
  | 'REMOTE_NOT_SUPPORTED'
  | 'SOURCE_NEVER_RAN'
  | 'NO_PRIOR_ASSISTANT'
  | 'UNSUPPORTED_HISTORY';

function forkError(code: ForkErrorCode, message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = code;
  return err;
}

function normalizePositiveInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/** SDK 副作用前拒绝复制任何跨过 agent_switch 的混合引擎历史。 */
async function assertForkRangeDoesNotCrossAgentSwitch(
  sourceSessionId: string,
  clearedAt: number | null,
  boundaryCreatedAt: number,
): Promise<void> {
  const boundary = await getDbClient().queryOne<{ id: string }>(
    `SELECT id FROM messages
      WHERE session_id = ?
        AND role = 'agent_switch'
        AND rewind_at IS NULL
        AND created_at < ?
        AND (? IS NULL OR created_at > ?)
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1`,
    [sourceSessionId, boundaryCreatedAt, clearedAt, clearedAt],
  );
  if (boundary) {
    throw forkError(
      'UNSUPPORTED_HISTORY',
      '目标消息之前包含引擎切换边界,无法把混合引擎历史复制到单一原生会话',
    );
  }
}

function augmentClaudeForkUuidMapForSyntheticRows(
  rows: Array<{ agentMeta: string | null }>,
  uuidMap: Map<string, string>,
  anchorIndex: ClaudeTranscriptAnchorIndex | null,
): Map<string, string> {
  if (!anchorIndex || uuidMap.size === 0) return uuidMap;
  const augmented = new Map(uuidMap);
  for (const row of rows) {
    const meta = parseClaudeAgentMeta(row.agentMeta);
    if (!meta.uuid || augmented.has(meta.uuid)) continue;
    const realSourceUuid = resolveClaudeForkAssistantAnchor(meta, anchorIndex);
    if (!realSourceUuid || realSourceUuid === meta.uuid) continue;
    const newUuid = augmented.get(realSourceUuid);
    if (newUuid) augmented.set(meta.uuid, newUuid);
  }
  return augmented;
}

/**
 * 把 source 会话在 messageClientId 处 fork 成新会话。fork 点支持两种 role：
 *
 *   - user 消息：复制该提问 **之前** 的所有内容（不含提问本身）——经典
 *     "改写这条提问" 流，renderer 会把提问文本预填进新会话 composer。
 *   - assistant 消息：复制到该回复 **所在 turn 的末尾**（含该回复）——
 *     "从这条 AI 回复分叉" 流。取 turn 粒度而非精确到该消息，是因为
 *     Claude 锚点 / Codex rollback 都是 turn 级能力，截到 turn 中间会留下
 *     dangling tool_use（API 要求 tool_use 必跟 tool_result）。
 *
 * `messageClientId` 即 messages 表的 **clientId**（renderer 这一侧的 ChatMessage
 * 只暴露 clientId，不暴露 DB 主键 id；`(sessionId, clientId)` 已是 unique 索引，
 * 用它定位行同样安全且不向 renderer 泄露主键。）
 *
 * - 用复制边界之前最近一条 assistant 的 `agentMeta.uuid` 作为 SDK
 *   `upToMessageId`（SDK 仅接受 SDK 自己分配的 uuid）。
 * - 新会话：reset cost/token/cleared/pinned；user_send_at = now（让 sidebar 立刻置顶）。
 * - 复制 messages：保留 createdAt 原值，重新生成 id + clientId 避免 unique 冲突。
 */
export async function forkSessionAtMessage(
  sourceSessionId: string,
  messageClientId: string,
): Promise<Session> {
  const db = getDbClient().drizzle;

  // 1. 读 source session
  const [source] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sourceSessionId))
    .limit(1);
  if (!source) {
    throw forkError('SOURCE_NOT_FOUND', `Source session ${sourceSessionId} 不存在`);
  }
  if (!source.sdkSessionId) {
    throw forkError('SOURCE_NEVER_RAN', '原会话尚未运行，无法 fork');
  }

  // 2. 读 target message —— 按 clientId 查（详见函数 doc）
  const [target] = await db
    .select()
    .from(messages)
    .where(
      and(eq(messages.sessionId, sourceSessionId), eq(messages.clientId, messageClientId)),
    )
    .limit(1);
  if (!target) {
    throw forkError('MESSAGE_NOT_FOUND', `Message ${messageClientId} 不存在于 ${sourceSessionId}`);
  }
  if (target.role !== 'user' && target.role !== 'assistant') {
    throw forkError('NOT_USER_MESSAGE', 'fork 只能在 user 或 assistant 消息上发起');
  }

  // 2.5 计算复制边界 boundaryCreatedAt（exclusive，复制 createdAt < boundary 的行）：
  //   user 目标      → target 自身 createdAt（不含 target，原语义）
  //   assistant 目标 → target 之后第一条未回滚 user 消息的 createdAt（把 target
  //                    所在 turn 完整带上）；没有后续 user 消息则取
  //                    MAX_SAFE_INTEGER 复制全部（= 从最新回复分叉整条会话）。
  let boundaryCreatedAt: number;
  if (target.role === 'user') {
    boundaryCreatedAt = target.createdAt;
  } else {
    const [nextUser] = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sourceSessionId),
          eq(messages.role, 'user'),
          gt(messages.createdAt, target.createdAt),
          isNull(messages.rewindAt),
        ),
      )
      .orderBy(asc(messages.createdAt))
      .limit(1);
    boundaryCreatedAt = nextUser ? nextUser.createdAt : Number.MAX_SAFE_INTEGER;
  }

  await assertForkRangeDoesNotCrossAgentSwitch(
    sourceSessionId,
    source.clearedAt,
    boundaryCreatedAt,
  );

  // 3. 计算 agent 侧截断信息。
  //
  // Claude: 反向找最近一条 assistant 且 agentMeta.uuid 存在 + **不是 subagent**
  // （parentUuid 不为空的是 subagent 的 assistant，不能当 fork 锚点；
  // CD 的 rewindSession 同样过滤 `!I.parent_tool_use_id`）
  // **跳过 rewind_at 已置位的行**：那些是上一次 rewind 软删的消息，再用它们当
  // 锚点会让 SDK upToMessageId 指向一条逻辑上已不存在的 assistant，jsonl 里找不到。
  //
  // Codex: 先 fork latest，再对新 thread rollback 尾部 N 个 turn。Codex 一次
  // user send 对应一个 turn，因此按边界之后（含边界）的未回滚 user 消息计数即可：
  // user 目标时 = target 自己 + 之后的 user-turn；assistant 目标时 = 该 turn
  // 之后的 user-turn（边界本身就是下一条 user 消息）。
  const isCodex = source.agentKind === 'codex';
  let assistantUuid: string | undefined;
  let tailTurnsToDrop: number | undefined;
  let claudeAnchorIndex: ClaudeTranscriptAnchorIndex | null = null;
  if (!isCodex) {
    claudeAnchorIndex = await loadClaudeTranscriptAnchorIndex({
      sdkSessionId: source.sdkSessionId,
      workingDir: source.workingDir,
    }).catch(() => null);
    const priorAssistants = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sourceSessionId),
          eq(messages.role, 'assistant'),
          lt(messages.createdAt, boundaryCreatedAt),
          isNull(messages.rewindAt),
        ),
      )
      .orderBy(asc(messages.createdAt));
    for (let i = priorAssistants.length - 1; i >= 0; i--) {
      const meta = parseClaudeAgentMeta(priorAssistants[i].agentMeta);
      const resolved = resolveClaudeForkAssistantAnchor(meta, claudeAnchorIndex);
      if (resolved) {
        assistantUuid = resolved;
        break;
      }
    }
    if (!assistantUuid) {
      throw forkError(
        'NO_PRIOR_ASSISTANT',
        '请在 AI 回复之后的提问上 fork',
      );
    }
  } else {
    const [tail] = await db
      .select({ value: count(messages.id) })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sourceSessionId),
          eq(messages.role, 'user'),
          gte(messages.createdAt, boundaryCreatedAt),
          isNull(messages.rewindAt),
        ),
      );
    tailTurnsToDrop = Number(tail?.value ?? 0);
  }

  // 4. 调 SDK forkSession (事务外) — Stage 2 C2 后走 maker.forkSdkSession,
  //    Claude: 内部一次性做完 sdk.forkSession + 两次 sdk.getSessionMessages + 建 uuidMap;
  //    Codex:  走 ThreadFork + ThreadRollback, uuidMap 返回空 Map (Codex 不存 message uuid)。
  // 已经是 [Fork 开头的不再嵌套前缀, 避免 [Fork] [Fork] ... 越叠越长
  // （部分前缀同时覆盖 forkSessionStripEncrypted 产出的 [Fork·已剥离] 变体）。
  const newTitle = source.title.startsWith('[Fork') ? source.title : `[Fork] ${source.title}`;
  const agentKind = isCodex ? 'codex' : 'claude-code';
  const { newSdkSessionId, uuidMap, initialContextTokens } = await getMaker().forkSdkSession(agentKind, {
    sourceSdkSessionId: source.sdkSessionId,
    upToMessageId: assistantUuid,
    ...(tailTurnsToDrop !== undefined ? { tailTurnsToDrop } : {}),
    title: newTitle,
    workingDir: source.workingDir ?? undefined,
  });
  const forkContextTokens = normalizePositiveInt(initialContextTokens);
  const forkContextWindow = normalizePositiveInt(source.contextWindow);

  // 5. SQLite 事务：insert 新 session + bulk copy messages
  const now = Date.now();
  const newSessionId = createBusinessSessionId();

  // 取 source messages: 复制边界之前 (boundary exclusive) 的所有行 — 与 SDK
  // upToMessageId 截断点 / thread rollback 后的新 thread 对齐。
  // 跳过 rewind_at 已置位的行 (软删消息不该进新 fork 会话)。
  const sourceMessages = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sourceSessionId),
        lt(messages.createdAt, boundaryCreatedAt),
        isNull(messages.rewindAt),
      ),
    )
    .orderBy(asc(messages.createdAt));

  const newMessageIds = sourceMessages.map(() => ({ id: createId(), clientId: createId() }));
  const txUuidMap = isCodex
    ? uuidMap
    : augmentClaudeForkUuidMapForSyntheticRows(sourceMessages, uuidMap, claudeAnchorIndex);
  await getDbClient().tx('fork.session', {
    sourceSessionId,
    targetCreatedAt: boundaryCreatedAt,
    newSession: {
      id: newSessionId,
      title: newTitle,
      workingDir: source.workingDir,
      model: source.model,
      // providerId 决定凭证形态(gateway-key / oauth-bearer)。fork 必须继承,否则新会话
      // 与原会话形态不一致,首次发消息会要求重启共享 codex 进程 → 任何会话在忙就永远排队
      // (2026-07-03 用户实报)。source 为 null 时保持 null(= 跟随系统默认),语义不变。
      providerId: source.providerId,
      effort: source.effort,
      permissionMode: source.permissionMode,
      status: 'active',
      sdkSessionId: newSdkSessionId,
      totalTokenUsage: 0,
      totalCostUsd: 0,
      contextTokens: forkContextTokens,
      contextWindow: forkContextWindow,
      fastMode: source.fastMode,
      clearedAt: null,
      pinnedAt: null,
      userSendAt: now,
      agentKind: source.agentKind,
      workspaceKind: source.workspaceKind,
      codexHistoryHasProductPrompt: source.codexHistoryHasProductPrompt,
      parentSessionId: source.id,
      forkedAtMessageId: messageClientId,
      createdAt: now,
      updatedAt: now,
    },
    uuidMap: Array.from(txUuidMap.entries()),
    newMessageIds,
  });

  // 6. 返回 mapper 转过的新 session（含 messageCount）
  const [row] = await db.select().from(sessions).where(eq(sessions.id, newSessionId));
  if (!row) {
    throw new Error('Fork session 创建后查询失败');
  }
  return sessionToCamel({ ...row, messageCount: sourceMessages.length });
}

export async function forkSessionStripEncrypted(sourceSessionId: string): Promise<Session> {
  const db = getDbClient().drizzle;

  const [source] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.id, sourceSessionId))
    .limit(1);
  if (!source) {
    throw forkError('SOURCE_NOT_FOUND', `Source session ${sourceSessionId} 不存在`);
  }
  // 先校验"类型"再校验"运行状态":non-codex 会话(可能 sdkSessionId 也为空)应拿到
  // 更准确的 NOT_CODEX_SESSION 而不是 SOURCE_NEVER_RAN。
  if (source.agentKind !== 'codex') {
    throw forkError('NOT_CODEX_SESSION', '仅 Codex 会话支持剥离协议加密内容');
  }
  // 远端 Codex 会话的 rollout 在远端机器上,本地 forkSdkSession 走本地 host 找不到,
  // 会失败或建出指向远端 workdir 的本地会话。本期不支持 → 显式拒绝(UI 也已隐藏入口)。
  if (source.remoteHostId) {
    throw forkError('REMOTE_NOT_SUPPORTED', '远端 Codex 会话暂不支持剥离 fork(rollout 在远端,本地无法剥离)');
  }
  if (!source.sdkSessionId) {
    throw forkError('SOURCE_NEVER_RAN', '原会话尚未运行，无法 fork');
  }

  const sourceMessages = await db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sourceSessionId), isNull(messages.rewindAt)))
    .orderBy(asc(messages.createdAt));
  const maxCreatedAt = sourceMessages.reduce(
    (max, message) => Math.max(max, Number(message.createdAt ?? 0)),
    0,
  );
  const copyBeforeCreatedAt = maxCreatedAt + 1;

  await assertForkRangeDoesNotCrossAgentSwitch(
    sourceSessionId,
    source.clearedAt,
    copyBeforeCreatedAt,
  );

  const newTitle = source.title.startsWith('[Fork·已剥离]')
    ? source.title
    : `[Fork·已剥离] ${source.title}`;
  const { newSdkSessionId, uuidMap } = await getMaker().forkSdkSession('codex', {
    sourceSdkSessionId: source.sdkSessionId,
    upToMessageId: undefined,
    title: newTitle,
    workingDir: source.workingDir ?? undefined,
    stripEncryptedReasoning: true,
  });

  const now = Date.now();
  const newSessionId = createBusinessSessionId();
  const newMessageIds = sourceMessages.map(() => ({ id: createId(), clientId: createId() }));
  await getDbClient().tx('fork.session', {
    sourceSessionId,
    targetCreatedAt: copyBeforeCreatedAt,
    newSession: {
      id: newSessionId,
      title: newTitle,
      workingDir: source.workingDir,
      model: source.model,
      // 同 forkSessionAtMessage:providerId 必须继承,防止凭证形态漂移。
      providerId: source.providerId,
      effort: source.effort,
      permissionMode: source.permissionMode,
      status: 'active',
      sdkSessionId: newSdkSessionId,
      totalTokenUsage: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextWindow: 0,
      fastMode: source.fastMode,
      clearedAt: null,
      pinnedAt: null,
      userSendAt: now,
      agentKind: source.agentKind,
      workspaceKind: source.workspaceKind,
      codexHistoryHasProductPrompt: source.codexHistoryHasProductPrompt,
      parentSessionId: source.id,
      forkedAtMessageId: null,
      createdAt: now,
      updatedAt: now,
    },
    uuidMap: Array.from(uuidMap.entries()),
    newMessageIds,
  });

  const [row] = await db.select().from(sessions).where(eq(sessions.id, newSessionId));
  if (!row) {
    throw new Error('Fork session 创建后查询失败');
  }
  return sessionToCamel({ ...row, messageCount: sourceMessages.length });
}
