/**
 * im/shared/turnActivity.ts
 * ---------------------------------------------------------------------------
 * IM 流式卡片的「过程展示」纯逻辑(无 IO, 可单测):
 *
 *   agent 一轮 turn 里大部分时间在跑工具调用, 最终文本要到收尾才产出 —
 *   过去 IM 卡片只流"结果", 用户盯着占位符干等。本模块把 tool_use 事件
 *   折叠成卡片顶部的过程区:
 *
 *     ⚙️ 第 7 步 · 42s
 *     > ✓ Grep `recordRoute`
 *     > ▸ Bash `pnpm vitest run`
 *
 *   - 滚动时间线: 只保留最近 MAX_VISIBLE_STEPS 步, 老的滚出(总步数在状态行)
 *   - 当前步标 ▸, 新 tool_use 到达视为上一步完成(标 ✓)。agent 串行调用为主,
 *     并行 tool_use 下标记会略有偏差 — 可接受, 不为此引入 tool_result 配对
 *   - turn 收口(done)后过程区整体移除, 最终消息只留干净的回复正文;
 *     error 收口保留过程区 — 用户能看到死在哪一步
 *
 * 工具标签语义对齐 renderer 的 AgentActionRow.extractDisplayParam(main 不能
 * import renderer, 这里维护精简副本): 文件类工具取 basename、Bash 截断命令、
 * 搜索类取 pattern/query。展示给用户的内容与 desktop 工具行一致 — 不引入
 * 新的信息暴露面。
 */

import path from 'node:path';

/** 时间线可见步数上限 — 再多手机端会把正文顶出屏幕。 */
export const MAX_VISIBLE_STEPS = 4;

/** 单步标签长度上限(含工具名), 防长命令/长 URL 撑爆卡片。 */
const STEP_LABEL_MAX = 64;

export interface TurnActivityState {
  /** 最近的步骤标签(rolling window, 最后一项为当前步)。 */
  recentSteps: string[];
  /** 本轮累计 tool_use 总数(含已滚出窗口的)。 */
  totalSteps: number;
  /** turn 派发时刻(ms)— 状态行的耗时显示基准。 */
  startedAt: number;
}

export function createTurnActivity(startedAt: number): TurnActivityState {
  return { recentSteps: [], totalSteps: 0, startedAt };
}

/** mcp__server__tool → server:tool(对齐 renderer 的 MCP 工具名展示语义)。 */
function formatMcpToolName(toolName: string): string {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
  return m ? `${m[1]}:${m[2]}` : toolName;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * tool_use → 一行人话标签。与 renderer extractDisplayParam 的取参语义一致;
 * 取不到识别参数时只显示工具名。
 */
export function formatToolStep(toolName: string, input: unknown): string {
  const inp = (input && typeof input === 'object' ? input : null) as Record<
    string,
    unknown
  > | null;
  let param = '';
  switch (toolName) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const fp = inp?.file_path;
      if (typeof fp === 'string' && fp) param = path.basename(fp);
      break;
    }
    case 'Bash': {
      const c = inp?.command;
      if (typeof c === 'string' && c) param = c;
      break;
    }
    case 'Grep':
    case 'Glob': {
      const p = inp?.pattern;
      if (typeof p === 'string' && p) param = p;
      break;
    }
    case 'WebFetch': {
      const u = inp?.url;
      if (typeof u === 'string' && u) param = u;
      break;
    }
    case 'WebSearch': {
      const q = inp?.query;
      if (typeof q === 'string' && q) param = q;
      break;
    }
    case 'Task': {
      const d = inp?.description;
      if (typeof d === 'string' && d) param = d;
      break;
    }
    default:
      break;
  }
  const name = formatMcpToolName(toolName);
  return truncate(param ? `${name} ${param}` : name, STEP_LABEL_MAX);
}

/** 记录一步 tool_use(窗口滚动 + 总数自增)。 */
export function pushToolStep(
  activity: TurnActivityState,
  toolName: string,
  input: unknown,
): void {
  activity.totalSteps += 1;
  activity.recentSteps.push(formatToolStep(toolName, input));
  if (activity.recentSteps.length > MAX_VISIBLE_STEPS) {
    activity.recentSteps.shift();
  }
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m${sec % 60 ? `${sec % 60}s` : ''}`;
}

/**
 * 渲染过程区 markdown(状态行 + 引用块时间线)。无任何步骤时返回空串 —
 * 纯文本快答的卡片与旧行为完全一致, 不多一行。
 *
 * `writing=true`(已有正文在流式)时当前步视为已完成, 额外一行"正在书写回复"。
 */
export function renderActivity(
  activity: TurnActivityState,
  now: number,
  writing: boolean,
): string {
  if (activity.totalSteps === 0) return '';
  const lines: string[] = [];
  lines.push(`⚙️ 第 ${activity.totalSteps} 步 · ${formatElapsed(now - activity.startedAt)}`);
  const last = activity.recentSteps.length - 1;
  activity.recentSteps.forEach((step, i) => {
    const marker = i === last && !writing ? '▸' : '✓';
    lines.push(`> ${marker} ${step}`);
  });
  if (writing) lines.push('> ▸ ✍️ 正在书写回复');
  return lines.join('\n');
}
