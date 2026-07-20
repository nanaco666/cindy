import type { AgentKind } from '@lizi/maker-core';

import { isCredentialModeSwitchBusyError } from '../maker-host/codex-credential-switch.js';
import type { DispatchWorkerTaskResult, OrcaWorkerEffort, OrcaWorkerStatus } from './orcaTeamService.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';

/** active team 的最小快照；创建 service 不直接持有 Drizzle row。 */
export interface OrcaTeamSnapshot {
  id: string;
  leadSessionId: string;
}

/** 解析 worker 默认 model/effort/fastMode 所需的 lead session 字段。 */
export interface OrcaLeadSessionSnapshot {
  id: string;
  agentKind: AgentKind;
  workingDir: string | null;
  model: string;
  effort: string | null;
  permissionMode: string;
  fastMode: boolean;
}

/** worker limit 与 duplicate label 校验只需要 worker 的身份、label 与占槽状态。 */
export interface OrcaWorkerListSnapshot {
  id: string;
  label: string | null;
  status: OrcaWorkerStatus;
}

/** New Maker 面板传来的按 agent 默认值缓存；undefined/null 都表示继续 fallback。 */
export interface OrcaWorkerDefaultsSnapshot {
  model?: string | null;
  effort?: string | null;
  fastMode?: boolean | null;
}

/** worker 创建边界只依赖 model 的运行能力，不直接耦合完整 capabilities 类型。 */
export interface OrcaWorkerModelCapabilities {
  id: string;
  efforts?: readonly string[];
  defaultEffort?: string | null;
  supportsFastMode?: boolean;
}

/** 写入 orca_workers 的最小输入；createdAt/updatedAt 等 store 默认值仍由 store 负责。 */
export interface OrcaWorkerRecordInput {
  id: string;
  teamId: string;
  sessionId: string;
  status: OrcaWorkerStatus;
  label: string;
  role: string;
  focused: boolean;
}

/** create_worker 的稳定业务错误码，IPC 与 MCP adapter 各自翻译。 */
export type OrcaWorkerCreationErrorCode =
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'DUPLICATE_LABEL'
  | 'WORKER_LIMIT_HARD_EXCEEDED'
  | 'BUDGET_MODEL_REQUIRES_API_MODE'
  | 'NO_PROVIDER_FOR_AGENT'
  | 'BUSY'
  | 'INTERNAL';

/** worker 创建结果保留首条派活 outcome，让调用方区分 created-but-not-dispatched。 */
export type OrcaWorkerCreationResult =
  | {
      ok: true;
      teamId: string;
      workerId: string;
      workerSessionId: string;
      softLimitExceeded?: boolean;
      dispatched?: boolean;
      dispatchOutcome?: DispatchWorkerTaskResult['dispatchOutcome'];
      /** initial_task 入队(未直发)时回传:排队消息的可寻址句柄,供 lead 查看/修改/撤回。 */
      queuedMessageId?: string;
      resolved: {
        agent: AgentKind;
        model: string;
        effort: string | null;
        fastMode: boolean;
        role: string;
        label: string;
      };
    }
  | {
      ok: false;
      errorCode: OrcaWorkerCreationErrorCode;
      message: string;
    };

/** 普通 create_worker 入参，已由 IPC/MCP adapter 做过粗校验。 */
export interface OrcaWorkerCreateParams {
  leadSessionId: string;
  role: string;
  agent: AgentKind;
  label: string;
  model?: string;
  effort?: OrcaWorkerEffort;
  fast?: boolean;
  initialTask?: string;
}

/** enableOrca 已经创建 team 后，可复用同一 worker 创建内核。 */
export interface OrcaWorkerCreateInTeamParams extends OrcaWorkerCreateParams {
  teamId: string;
}

/** creation service 的 I/O 边界；register.ts 负责把 DB、Maker 与 broadcast 注入进来。 */
export interface OrcaWorkerCreationDeps {
  getActiveTeamByLead(leadSessionId: string): Promise<OrcaTeamSnapshot | null>;
  listWorkersByLead(leadSessionId: string): Promise<OrcaWorkerListSnapshot[]>;
  isActiveWorkerStatus(status: OrcaWorkerStatus): boolean;
  readCollaborationSettings(): { workerSoftLimit: number; workerHardLimit: number };
  getLeadSessionRow(leadSessionId: string): Promise<OrcaLeadSessionSnapshot | null>;
  getWorkerDefaults(agent: AgentKind): OrcaWorkerDefaultsSnapshot;
  getAvailableModels(agent: AgentKind): OrcaWorkerModelCapabilities[];
  /**
   * 各 agent 当前**已连接**的模型供应商展示名(空数组 = 该 agent 无可用 provider)。
   * host 注入实现:listProviders() + connectedProvidersForAgent(views, agent).map(p => p.name)。
   * 是 worker 启动 preflight 的唯一判定来源(catalog 驱动,不写死供应商)。
   */
  getProviderAvailability(): Promise<Record<AgentKind, string[]>>;
  readClaudeApiKey(): string | null;
  createId(): string;
  createSessionId(): string;
  buildCreateOptsWithStderr(opts: MakerSessionCreateOpts): MakerSessionCreateOpts;
  bootstrapSession(opts: MakerSessionCreateOpts): Promise<{
    session: { id: string; agentKind: AgentKind };
    didInjectOrcaInstructions: boolean;
    didInjectProjectContext: boolean;
  }>;
  addOrUpdateWorker(worker: OrcaWorkerRecordInput): Promise<void>;
  markOrcaRoleIfNeeded(sessionId: string, role: 'worker'): Promise<void>;
  closeWorkerSession(sessionId: string): Promise<void>;
  archiveWorkerSession(sessionId: string): Promise<void>;
  forgetWorkerSession(sessionId: string): void;
  removeWorker(workerId: string): Promise<void>;
  dispatchWorkerTask(params: {
    targetSessionId: string;
    message: string;
    dispatchMeta: {
      source: string;
      context: string;
    };
  }): Promise<DispatchWorkerTaskResult>;
  broadcastSessionCreated(sessionId: string): void;
  broadcastOrcaWorkerChanged(leadSessionId: string): void;
}

/** Orca worker 创建服务，只负责创建既有 team 下的新 worker，不负责 team lifecycle。 */
export interface OrcaWorkerCreationService {
  createWorker(params: OrcaWorkerCreateParams): Promise<OrcaWorkerCreationResult>;
  createWorkerInTeam(params: OrcaWorkerCreateInTeamParams): Promise<OrcaWorkerCreationResult>;
}

function toInternalFailure(err: unknown): Extract<OrcaWorkerCreationResult, { ok: false }> {
  if (isCredentialModeSwitchBusyError(err)) {
    return {
      ok: false,
      errorCode: 'BUSY',
      message: err.message,
    };
  }
  return {
    ok: false,
    errorCode: 'INTERNAL',
    message: err instanceof Error ? err.message : String(err),
  };
}

function normalizeRequiredText(value: string, field: string): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, message: `${field} required` };
  return { ok: true, value: trimmed };
}

const ORCA_WORKER_LABEL_MAX_LENGTH = 32;
const ORCA_WORKER_LABEL_PATTERN = /^[a-z0-9_-]+$/i;

/** worker label 是 switch_focus 的稳定定位键，所有创建入口都走同一组 slug 约束。 */
export function normalizeOrcaWorkerLabel(value: string): { ok: true; value: string } | { ok: false; message: string } {
  const label = normalizeRequiredText(value, 'label');
  if (!label.ok) return label;
  if (label.value.length > ORCA_WORKER_LABEL_MAX_LENGTH) {
    return { ok: false, message: 'label must be 1-32 chars' };
  }
  if (!ORCA_WORKER_LABEL_PATTERN.test(label.value)) {
    return { ok: false, message: 'label may only contain letters, numbers, hyphens and underscores' };
  }
  return label;
}

type ResolveWorkerConfigResult =
  | {
      ok: true;
      model: string;
      effort: string | null;
      fastMode: boolean;
    }
  | {
      ok: false;
      message: string;
    };

function modelValidEfforts(model: OrcaWorkerModelCapabilities): readonly string[] {
  return model.efforts ?? [];
}

function normalizeResolvedEffort(params: {
  model: OrcaWorkerModelCapabilities;
  effort: string | null | undefined;
  explicit: boolean;
}): { ok: true; effort: string | null } | { ok: false; message: string } {
  const { model, effort, explicit } = params;
  const validEfforts = modelValidEfforts(model);
  const defaultEffort = model.defaultEffort ?? null;
  if (effort == null) return { ok: true, effort: defaultEffort };
  if (validEfforts.includes(effort)) return { ok: true, effort };
  if (effort === 'minimal' && !explicit && validEfforts.includes('low')) {
    return { ok: true, effort: 'low' };
  }
  if (effort === 'max' && !explicit && validEfforts.includes('xhigh')) {
    return { ok: true, effort: 'xhigh' };
  }
  if (effort === 'xhigh' && !explicit && validEfforts.includes('max')) {
    return { ok: true, effort: 'max' };
  }
  if (!explicit) return { ok: true, effort: defaultEffort };
  return {
    ok: false,
    message: `effort "${effort}" not supported by model "${model.id}". valid: ${validEfforts.join(', ') || 'none'}`,
  };
}

function resolveWorkerConfig(params: {
  input: OrcaWorkerCreateParams;
  lead: OrcaLeadSessionSnapshot;
  defaults: OrcaWorkerDefaultsSnapshot;
  availableModels: OrcaWorkerModelCapabilities[];
}): ResolveWorkerConfigResult {
  const { input, lead, defaults, availableModels } = params;
  const model = input.model
    ?? defaults.model
    ?? (input.agent === lead.agentKind ? lead.model : input.agent === 'codex' ? 'gpt-5.5' : 'claude-sonnet-4-6');
  const modelCapabilities = availableModels.find((candidate) => candidate.id === model);
  if (!modelCapabilities) {
    return {
      ok: false,
      message: `model "${model}" not available for ${input.agent}. valid: ${availableModels.map((candidate) => candidate.id).join(', ')}`,
    };
  }
  const normalizedEffort = normalizeResolvedEffort({
    model: modelCapabilities,
    effort: input.effort ?? defaults.effort ?? lead.effort,
    explicit: input.effort !== undefined,
  });
  if (!normalizedEffort.ok) return normalizedEffort;
  return {
    ok: true,
    model,
    effort: normalizedEffort.effort,
    fastMode: modelCapabilities.supportsFastMode === false
      ? false
      : ((input.agent === 'codex' && input.fast !== undefined)
          ? input.fast
          : (defaults.fastMode ?? !!lead.fastMode)),
  };
}

export function budgetModelRequiresApiKey(agent: AgentKind, model: string, hasApiKey: boolean): boolean {
  return agent === 'codex' && model.startsWith('codex/') && !hasApiKey;
}

export function budgetModelRequiresApiKeyMessage(model: string): string {
  return `骨折版（codex/ 低价路由）需要先在设置里连接 Cindy AI 才能使用 "${model}"。`;
}

/** agent 的人类可读名,用于 preflight 失败信息。 */
function agentDisplayName(agent: AgentKind): string {
  return agent === 'codex' ? 'Codex' : 'Claude Code';
}

/**
 * worker 启动 preflight 失败信息:该 agent 无任何已连接的模型供应商时,
 * 引导用户去「设置 → 模型供应商」配置;若**其它** agent 已有可用供应商,则一并建议改用该 agent。
 * 纯函数(无 IO),便于单测。
 */
export function buildNoProviderMessage(
  agent: AgentKind,
  availability: Record<AgentKind, string[]>,
): string {
  const base = `${agentDisplayName(agent)} 当前没有可用的模型供应商(provider)。请在「设置 → 模型供应商」连接一个支持 ${agentDisplayName(agent)} 的供应商后重试`;
  const others = (['claude-code', 'codex'] as AgentKind[]).filter(
    (a) => a !== agent && (availability[a]?.length ?? 0) > 0,
  );
  if (others.length === 0) return `${base}。`;
  const suggestion = others
    .map((a) => `${agentDisplayName(a)}(已连接:${availability[a].join(' / ')})`)
    .join('、');
  return `${base},或改用已连接供应商的 agent 创建 worker(可用:${suggestion})。`;
}

export function createOrcaWorkerCreationService(deps: OrcaWorkerCreationDeps): OrcaWorkerCreationService {
  async function cleanupBootstrappedWorkerSession(sessionId: string): Promise<void> {
    await deps.closeWorkerSession(sessionId).catch(() => undefined);
    try {
      deps.forgetWorkerSession(sessionId);
    } catch {
      // cache 清理是 best-effort；DB 归档仍继续执行。
    }
    await deps.archiveWorkerSession(sessionId).catch(() => undefined);
  }

  async function createWorker(params: OrcaWorkerCreateParams): Promise<OrcaWorkerCreationResult> {
    const team = await deps.getActiveTeamByLead(params.leadSessionId);
    if (!team) {
      return { ok: false, errorCode: 'NOT_FOUND', message: 'no active team for this lead' };
    }
    return createWorkerInTeam({ ...params, teamId: team.id });
  }

  async function createWorkerInTeam(params: OrcaWorkerCreateInTeamParams): Promise<OrcaWorkerCreationResult> {
    const role = normalizeRequiredText(params.role, 'role');
    if (!role.ok) return { ok: false, errorCode: 'INVALID_PARAMS', message: role.message };
    if (role.value.length > 32) {
      return { ok: false, errorCode: 'INVALID_PARAMS', message: 'role must be 1-32 chars' };
    }
    const label = normalizeOrcaWorkerLabel(params.label);
    if (!label.ok) return { ok: false, errorCode: 'INVALID_PARAMS', message: label.message };

    const existing = await deps.listWorkersByLead(params.leadSessionId);
    if (existing.some((worker) => worker.label === label.value)) {
      return { ok: false, errorCode: 'DUPLICATE_LABEL', message: `label "${label.value}" already used in this team` };
    }

    const settings = deps.readCollaborationSettings();
    const activeCount = existing.filter((worker) => deps.isActiveWorkerStatus(worker.status)).length;
    if (activeCount >= settings.workerHardLimit) {
      return { ok: false, errorCode: 'WORKER_LIMIT_HARD_EXCEEDED', message: `hard limit ${settings.workerHardLimit} reached` };
    }
    const softLimitExceeded = activeCount >= settings.workerSoftLimit;

    const availableModels = deps.getAvailableModels(params.agent);
    if (params.model) {
      const validModels = availableModels.map((model) => model.id);
      if (!validModels.includes(params.model)) {
        return {
          ok: false,
          errorCode: 'INVALID_PARAMS',
          message: `model "${params.model}" not available for ${params.agent}. valid: ${validModels.join(', ')}`,
        };
      }
    }

    // worker 启动 preflight:该 agent 必须至少有一个已连接的模型供应商,否则 worker 即便建出来,
    // 第一次发请求时也会在代理层因「无上游可路由」失败(留下 orphan session)。fail-fast 在 bootstrap 之前。
    const providerAvailability = await deps.getProviderAvailability();
    if ((providerAvailability[params.agent] ?? []).length === 0) {
      return {
        ok: false,
        errorCode: 'NO_PROVIDER_FOR_AGENT',
        message: buildNoProviderMessage(params.agent, providerAvailability),
      };
    }

    const lead = await deps.getLeadSessionRow(params.leadSessionId);
    if (!lead) {
      return { ok: false, errorCode: 'NOT_FOUND', message: `lead session ${params.leadSessionId} not found` };
    }

    const defaults = deps.getWorkerDefaults(params.agent);
    const resolved = resolveWorkerConfig({ input: params, lead, defaults, availableModels });
    if (!resolved.ok) {
      return { ok: false, errorCode: 'INVALID_PARAMS', message: resolved.message };
    }
    if (budgetModelRequiresApiKey(params.agent, resolved.model, deps.readClaudeApiKey() != null)) {
      return {
        ok: false,
        errorCode: 'BUDGET_MODEL_REQUIRES_API_MODE',
        message: budgetModelRequiresApiKeyMessage(resolved.model),
      };
    }

    const workerSessionId = deps.createSessionId();
    const workerId = deps.createId();
    const workerVendorOptions = {
      orcaRole: 'worker' as const,
      orcaWorkflowId: params.teamId,
      orcaLeadSessionId: params.leadSessionId,
      orcaWorkerId: workerId,
      orcaWorkerSessionId: workerSessionId,
    };

    const workerOpts = deps.buildCreateOptsWithStderr({
      id: workerSessionId,
      agentKind: params.agent,
      workingDir: lead.workingDir ?? '',
      model: resolved.model,
      effort: resolved.effort as MakerSessionCreateOpts['effort'],
      fastMode: resolved.fastMode,
      permissionMode: 'bypassPermissions',
      title: `Worker · ${role.value} · ${label.value}`,
      orcaRole: 'worker',
      vendorOptions: workerVendorOptions,
    });

    let workerSession: { id: string; agentKind: AgentKind };
    try {
      const bootstrapped = await deps.bootstrapSession(workerOpts);
      workerSession = bootstrapped.session;
    } catch (err) {
      return toInternalFailure(err);
    }

    try {
      await deps.addOrUpdateWorker({
        id: workerId,
        teamId: params.teamId,
        sessionId: workerSession.id,
        status: 'idle',
        label: label.value,
        role: role.value,
        focused: false,
      });
    } catch (err) {
      await cleanupBootstrappedWorkerSession(workerSession.id);
      return toInternalFailure(err);
    }

    try {
      await deps.markOrcaRoleIfNeeded(workerSession.id, 'worker');
    } catch (err) {
      await cleanupBootstrappedWorkerSession(workerSession.id);
      await deps.removeWorker(workerId).catch(() => undefined);
      return toInternalFailure(err);
    }

    return {
      ok: true,
      teamId: params.teamId,
      workerId,
      workerSessionId: workerSession.id,
      softLimitExceeded,
      resolved: {
        agent: params.agent,
        model: resolved.model,
        effort: resolved.effort,
        fastMode: resolved.fastMode,
        role: role.value,
        label: label.value,
      },
    };
  }

  return {
    createWorker,
    createWorkerInTeam,
  };
}
