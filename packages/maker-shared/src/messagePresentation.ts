import {
  formatDuration,
  type MessageRenderItem,
  type MessageRenderNormalizedMessage,
  type MessageRenderTodoCardItem,
  type MessageRenderTodoItem,
  type MessageRenderToolGroupItem,
  type MessageRenderWorkChildItem,
  type MessageRenderWorkGroupItem,
} from './messageRender';
import {
  describeToolUse,
  truncateToolText,
  type ToolUseDescriptor,
} from './toolUseDescriptor';
import type { CommandIntentAction } from './commandIntent';

export type MessageFoldHeaderChevronPosition = 'leading' | 'trailing';

export type MessageFoldHeaderVariant = 'card' | 'plain';

export interface MessageFoldHeaderPresentation {
  chevronPosition: MessageFoldHeaderChevronPosition;
  chevronSize: number;
  defaultExpanded: boolean;
  iconSize: number;
  summaryCount: number;
  subtitle: string | null;
  title: string;
  variant: MessageFoldHeaderVariant;
}

export interface ToolGroupPresentation {
  header: MessageFoldHeaderPresentation;
  title: string;
  /** 组内是否有仍在执行的工具行（块头图标同槽位换成进行中形态，对齐桌面 #454）。 */
  hasRunning: boolean;
}

export interface WorkGroupPresentation {
  header: MessageFoldHeaderPresentation;
  subtitle: string;
  title: string;
}

export type ToolRowStatus = 'running' | 'done';

export interface ToolRowPresentation {
  hasError: boolean;
  /** 人话主文案（issue #450 手机版）：description 成句 / 意图动词 + 参数 / MCP `调用 server · tool`。 */
  label: string;
  /** 次要细节（命令原文 / 完整路径 / MCP detail），桌面 hover title 的等价物；无则不渲染。 */
  detail?: string;
  /** running = tool_result 未到且会话流式中；其余（含无 settled 信号的历史消息）恒 done，防永久转圈。 */
  status: ToolRowStatus;
}

export interface ToolRowPresentationOptions {
  isSessionStreaming?: boolean;
}

export interface TodoStatusPresentation {
  status: MessageRenderTodoItem['status'];
}

export interface TodoCardPresentation {
  activeContent?: string;
  completed: number;
  defaultExpanded: boolean;
  header: MessageFoldHeaderPresentation;
  title: string;
  total: number;
}

export type MessageActionBarAlignment = 'left' | 'right';

export type MessageActionBarItemId = 'copy' | 'cost' | 'fork' | 'rewind' | 'streaming' | 'time';

export interface MessageActionBarPresentationInput {
  align: 'agent' | 'user';
  canCopy: boolean;
  canFork: boolean;
  canRewind: boolean;
  hasTime: boolean;
  hasTurnCost: boolean;
  isStreaming: boolean;
}

export interface MessageActionBarPresentation {
  align: MessageActionBarAlignment;
  buttonSize: number;
  iconSize: number;
  items: MessageActionBarItemId[];
}

export type MessageBubbleDensity = 'compact' | 'standard' | 'rich';

export interface MessageBubblePresentationInput {
  align?: 'user' | 'agent';
  attachmentCount?: number;
  body?: string;
  hasSystemCard?: boolean;
  isStreaming?: boolean;
  kind: string;
  mediaCount?: number;
  secondaryBody?: string;
}

export interface MessageBubblePresentation {
  density: MessageBubbleDensity;
  hasAuxiliaryContent: boolean;
  isUserAligned: boolean;
}

type MessagePresentationToolLike = MessageRenderNormalizedMessage & {
  diff?: unknown;
  media?: readonly unknown[];
  /** tool_result 是否已到达（normalize 层经 hasResultFor 写入）；undefined = 无信号（老数据），按已完成处理。 */
  toolSettled?: boolean;
};

type ToolSummaryVerb =
  | 'edited'
  | 'created'
  | 'ran'
  | 'read'
  | 'updated'
  | 'searched'
  | 'fetched'
  | 'used';

interface ToolSummaryVerbEntry {
  verb: ToolSummaryVerb;
  count: number;
}

const TOOL_SUMMARY_VERB_BY_LABEL: Record<string, ToolSummaryVerb> = {
  Edit: 'edited',
  MultiEdit: 'edited',
  Write: 'created',
  Bash: 'ran',
  exec: 'ran',
  Read: 'read',
  TodoWrite: 'updated',
  Glob: 'searched',
  Grep: 'searched',
  WebFetch: 'fetched',
  WebSearch: 'fetched',
  web_search: 'fetched',
};

const TOOL_SUMMARY_VERB_ORDER: ToolSummaryVerb[] = [
  'edited',
  'ran',
  'read',
  'updated',
  'created',
  'searched',
  'fetched',
  'used',
];

// 聚合摘要短语（中文硬编码，文案对齐桌面 zh-CN `chat.agentActions.part.*`）。
const TOOL_SUMMARY_PART_ZH: Record<ToolSummaryVerb, (count: number) => string> = {
  edited: (count) => `编辑 ${count} 个文件`,
  created: (count) => `创建 ${count} 个文件`,
  ran: (count) => `运行 ${count} 条命令`,
  read: (count) => `读取 ${count} 个文件`,
  updated: () => '更新待办',
  searched: () => '执行搜索',
  fetched: () => '访问网络',
  used: (count) => `调用 ${count} 个工具`,
};

// 行级动词（中文硬编码，对齐桌面 zh-CN `chat.agentActionRow.verb.*`）。
const TOOL_ROW_VERB_ZH = {
  read: '读取',
  edit: '编辑',
  create: '创建',
  run: '运行',
  search: '搜索',
  fetch: '访问',
  use: '调用',
  updateTodos: '更新待办',
} as const;

// 命令意图动词（issue #450 codex 支持，对齐桌面 `verbLabelKeyForIntent` 的 zh-CN 文案）。
const INTENT_VERB_ZH: Record<CommandIntentAction, string> = {
  read: '读取',
  list: '列出',
  search: '搜索',
  fetch: '访问',
  install: '安装依赖',
  test: '运行测试',
  build: '构建',
  lint: '代码检查',
  typecheck: '类型检查',
};

const TOOL_ROW_TEXT_MAX_CHARS = 60;

/** 次行命令原文的截断上限(与桌面 hover 展示完整命令的意图对齐,手机放宽到 200 字)。 */
const COMMAND_DETAIL_MAX_CHARS = 200;

export function summarizeMessageBubblePresentation(
  input: MessageBubblePresentationInput,
): MessageBubblePresentation {
  const attachmentCount = Math.max(0, input.attachmentCount ?? 0);
  const mediaCount = Math.max(0, input.mediaCount ?? 0);
  const body = input.body?.trim() ?? '';
  const secondary = input.secondaryBody?.trim() ?? '';
  const hasAuxiliaryContent = attachmentCount > 0 || mediaCount > 0 || secondary.length > 0 || !!input.hasSystemCard;
  const isUserAligned = input.align === 'user' || input.kind === 'user';
  const density = messageBubbleDensity({
    body,
    hasAuxiliaryContent,
    isStreaming: input.isStreaming === true,
    kind: input.kind,
  });

  return {
    density,
    hasAuxiliaryContent,
    isUserAligned,
  };
}

export function buildMessageActionBarPresentation(
  input: MessageActionBarPresentationInput,
): MessageActionBarPresentation {
  if (input.isStreaming) {
    return {
      align: 'left',
      buttonSize: 24,
      iconSize: 14,
      items: ['streaming'],
    };
  }

  const agentItems: Array<MessageActionBarItemId | null> = [
      input.canCopy ? 'copy' : null,
      input.canFork ? 'fork' : null,
      input.hasTime ? 'time' : null,
      input.hasTurnCost ? 'cost' : null,
    ];
  const userItems: Array<MessageActionBarItemId | null> = [
      input.hasTime ? 'time' : null,
      input.canCopy ? 'copy' : null,
      input.canRewind ? 'rewind' : null,
      input.canFork ? 'fork' : null,
    ];
  const items = (input.align === 'agent' ? agentItems : userItems).filter(isMessageActionBarItemId);

  return {
    align: input.align === 'user' ? 'right' : 'left',
    buttonSize: 24,
    iconSize: 14,
    items,
  };
}

export function summarizeToolGroupPresentation<
  TMessage extends MessagePresentationToolLike,
>(
  item: MessageRenderToolGroupItem<TMessage>,
  options: ToolRowPresentationOptions = {},
): ToolGroupPresentation {
  const primary = item.tools[0];
  const title = formatToolGroupSummary(item.tools)
    || (primary?.label ? `调用 ${primary.label}` : '调用了工具');
  const hasRunning = item.tools.some((tool) => toolRowStatus(tool, options) === 'running');

  // 折叠工具组只显示聚合标题(desktopPlainFoldHeader.subtitle 恒 null,对齐桌面):
  // 单个工具的人话文案在展开后的 tool row 里已呈现,折叠头不再挂一行冗余副标题。
  return {
    header: desktopPlainFoldHeader({ title }),
    title,
    hasRunning,
  };
}

export function summarizeToolRowPresentation<
  TMessage extends MessagePresentationToolLike,
>(tool: TMessage, options: ToolRowPresentationOptions = {}): ToolRowPresentation {
  const descriptor = toolRowDescriptor(tool);
  // 读文件 / 搜索 / 网页类工具的结果正文是「内容」而非执行状态,全文错误关键词匹配
  // 必然误报(文件里出现 error / 失败 字样 ≠ 工具失败);但真实失败也常以纯文本落盘
  // (持久化链路无 is_error 标志),所以对这类工具改用锚定判定而非整段关闭检测。
  const hasError = isContentOutputDescriptor(descriptor)
    ? isContentToolFailureLike(tool)
    : isToolErrorLike(tool);
  const text = formatToolRowText(descriptor);

  return {
    hasError,
    label: text.label || tool.label || 'tool',
    ...(text.detail ? { detail: text.detail } : {}),
    status: toolRowStatus(tool, options),
  };
}

/**
 * 从 normalize 消息解出工具描述符：source 上 toolName / input 走 content 透传
 * （mobile 的 RemoteMessage 形态），残缺时退化 generic（describeToolUse 自身防御）。
 */
function toolRowDescriptor(tool: MessagePresentationToolLike): ToolUseDescriptor {
  const source = tool.source;
  const content = readRecordValue(source.content);
  const toolName = readNonEmptyStringValue(source.toolName)
    ?? readNonEmptyStringValue(content?.toolName)
    ?? readNonEmptyStringValue(content?.name)
    ?? tool.label
    ?? '';
  const input = source.toolInput !== undefined ? source.toolInput : content?.input;
  return describeToolUse(toolName, input);
}

/**
 * 描述符 → 手机版中文行文案（对齐桌面 AgentActionRow 的展示决策，issue #450）：
 * - Bash 有模型 description → 独立成句，命令原文降为次要细节；
 * - command intent（codex commandActions / 本地规则）命中 → 意图动词 + 目标；
 * - MCP / dynamic / collab → `调用 server · tool`；
 * - 其余按工具类型给动词 + 参数，解析不出时回退命令 / 工具名原文。
 */
function formatToolRowText(descriptor: ToolUseDescriptor): { label: string; detail?: string } {
  switch (descriptor.kind) {
    case 'command': {
      if (descriptor.description) {
        return {
          label: descriptor.description,
          ...commandDetail(descriptor.command),
        };
      }
      const intent = descriptor.intent;
      if (intent) {
        const target = intent.target ?? descriptor.command;
        return {
          label: joinVerb(INTENT_VERB_ZH[intent.action], truncateToolText(target, TOOL_ROW_TEXT_MAX_CHARS)),
          // target 存在时命令原文总进次行;target 回退命令原文时只有被截断才需要次行兜底。
          ...(intent.target ? commandDetail(descriptor.command) : commandDetailIfTruncated(descriptor.command)),
        };
      }
      if (!descriptor.command) return { label: descriptor.toolName };
      return {
        label: joinVerb(TOOL_ROW_VERB_ZH.run, truncateToolText(descriptor.command, TOOL_ROW_TEXT_MAX_CHARS)),
        // 长命令被 label 截断时,次行保留(更长的)原文,便于审计实际执行了什么。
        ...commandDetailIfTruncated(descriptor.command),
      };
    }
    case 'file': {
      const verb = descriptor.action === 'read'
        ? TOOL_ROW_VERB_ZH.read
        : descriptor.action === 'edit'
          ? TOOL_ROW_VERB_ZH.edit
          : TOOL_ROW_VERB_ZH.create;
      return {
        label: joinVerb(verb, descriptor.fileName),
        ...(descriptor.filePath !== descriptor.fileName ? { detail: descriptor.filePath } : {}),
      };
    }
    case 'search':
      return {
        label: joinVerb(TOOL_ROW_VERB_ZH.search, truncateToolText(descriptor.pattern, TOOL_ROW_TEXT_MAX_CHARS)),
        ...(descriptor.path ? { detail: descriptor.path } : {}),
      };
    case 'web':
      return {
        label: joinVerb(
          descriptor.mode === 'fetch' ? TOOL_ROW_VERB_ZH.fetch : TOOL_ROW_VERB_ZH.search,
          truncateToolText(descriptor.target, TOOL_ROW_TEXT_MAX_CHARS),
        ),
      };
    case 'todo':
      return { label: TOOL_ROW_VERB_ZH.updateTodos };
    case 'task':
      return {
        label: descriptor.description ?? descriptor.toolName,
        ...(descriptor.subagentType ? { detail: descriptor.subagentType } : {}),
      };
    case 'mcp':
      return {
        label: joinVerb(TOOL_ROW_VERB_ZH.use, `${descriptor.serverLabel} · ${descriptor.toolLabel}`),
        ...(descriptor.detail ? { detail: descriptor.detail } : {}),
      };
    case 'dynamic':
      return {
        label: joinVerb(
          TOOL_ROW_VERB_ZH.use,
          descriptor.namespace ? `${descriptor.namespace} · ${descriptor.toolLabel}` : descriptor.toolLabel,
        ),
        ...(descriptor.detail ? { detail: descriptor.detail } : {}),
      };
    case 'collab':
      return {
        label: joinVerb(TOOL_ROW_VERB_ZH.use, descriptor.toolLabel),
        ...(descriptor.detail ? { detail: descriptor.detail } : {}),
      };
    default:
      return {
        label: joinVerb(TOOL_ROW_VERB_ZH.use, descriptor.toolName),
        ...(descriptor.detail ? { detail: descriptor.detail } : {}),
      };
  }
}

function joinVerb(verb: string, target: string): string {
  return target ? `${verb} ${target}` : verb;
}

function commandDetail(command: string): { detail?: string } {
  return command ? { detail: truncateToolText(command, COMMAND_DETAIL_MAX_CHARS) } : {};
}

/** 命令超出 label 截断长度才给次行:label 已含完整原文时不重复占一行。 */
function commandDetailIfTruncated(command: string): { detail?: string } {
  return command.trim().length > TOOL_ROW_TEXT_MAX_CHARS
    ? { detail: truncateToolText(command, COMMAND_DETAIL_MAX_CHARS) }
    : {};
}

function toolRowStatus(
  tool: MessagePresentationToolLike,
  options: ToolRowPresentationOptions,
): ToolRowStatus {
  if (tool.toolSettled === false && options.isSessionStreaming === true) return 'running';
  return 'done';
}

export function summarizeTodoCardPresentation(item: MessageRenderTodoCardItem): TodoCardPresentation {
  const completed = item.todos.filter((todo) => todo.status === 'completed').length;
  const total = item.todos.length;
  const active = item.todos.find((todo) => todo.status === 'in_progress') ?? item.todos[item.todos.length - 1];
  const activeContent = active?.content;
  const title = `${completed}/${total}${activeContent ? ` · ${activeContent}` : ''}`;

  return {
    activeContent,
    completed,
    defaultExpanded: true,
    header: desktopTodoFoldHeader({
      summaryCount: total,
      title,
    }),
    title,
    total,
  };
}

export function todoStatusPresentation(status: MessageRenderTodoItem['status']): TodoStatusPresentation {
  return {
    status,
  };
}

export function summarizeWorkGroupPresentation<
  TMessage extends MessagePresentationToolLike,
>(item: MessageRenderWorkGroupItem<TMessage>): WorkGroupPresentation {
  const title = item.durationMs !== undefined ? `已工作 ${formatDuration(item.durationMs)}` : '工作过程';

  return {
    header: desktopPlainFoldHeader({ title }),
    subtitle: '',
    title,
  };
}

export function countMessageRenderItemDiffs<
  TMessage extends MessagePresentationToolLike,
>(items: readonly MessageRenderItem<TMessage>[]): number {
  return items.reduce((sum, item) => sum + countItemDiffs(item), 0);
}

export function isToolErrorLike(
  tool: Pick<MessageRenderNormalizedMessage, 'body' | 'secondaryBody'>,
  keywordHeuristic = true,
): boolean {
  const secondary = tool.secondaryBody?.trim();
  if (secondary && isErrorRecord(secondary)) return true;
  if (!keywordHeuristic) return false;
  const text = [tool.body, secondary].filter(Boolean).join('\n');
  return /\b(error|failed|failure|exception|traceback|stderr|non-zero|denied|timed out|timeout)\b|exit code [1-9]|错误|失败|异常|拒绝|超时/i
    .test(text);
}

/** 结果正文是「内容」的工具(读文件 / 搜索 / 网页):对其输出跑全文错误关键词匹配没有意义。 */
function isContentOutputDescriptor(descriptor: ToolUseDescriptor): boolean {
  if (descriptor.kind === 'file') return descriptor.action === 'read';
  return descriptor.kind === 'search' || descriptor.kind === 'web';
}

/**
 * 内容类工具的失败判定:只认三类明确信号——结构化错误记录、`<tool_use_error>`
 * 标记、首行以失败句式开头。真实工具错误输出是短消息且失败措辞在开头
 * (`Error: ENOENT ...` / `request failed ...`),正文中段出现关键词的是内容命中,不算。
 */
export function isContentToolFailureLike(
  tool: Pick<MessageRenderNormalizedMessage, 'body' | 'secondaryBody'>,
): boolean {
  if (isToolErrorLike(tool, false)) return true;
  const secondary = tool.secondaryBody?.trim();
  if (!secondary) return false;
  if (secondary.includes('<tool_use_error>')) return true;
  const firstLine = secondary.split('\n', 1)[0].trim();
  // 字符类是全角冒号 U+FF1A + 半角冒号 U+003A 并列;别把全角的归一化成半角,
  // 会变成重复字符类(CodeQL 已拦过一次)。
  return /^(error\b|request failed\b|failed to \S|enoent\b|eacces\b|permission denied\b|错误[：:]|(读取|搜索|请求|抓取)失败|无法(读取|访问|打开|获取))/i
    .test(firstLine);
}

function isMessageActionBarItemId(value: MessageActionBarItemId | null): value is MessageActionBarItemId {
  return value !== null;
}

// 聚合摘要头（中文，对齐桌面 zh-CN：「编辑 3 个文件、运行 2 条命令 和 调用 1 个工具」口径的分隔符）。
function formatToolGroupSummary<TMessage extends MessagePresentationToolLike>(
  tools: readonly TMessage[],
): string {
  const entries = aggregateToolSummaryVerbs(tools);
  const truncatedExtra = entries.length > 5 ? entries.length - 5 : 0;
  const parts = entries.slice(0, 5).map((entry) => TOOL_SUMMARY_PART_ZH[entry.verb](entry.count));
  if (truncatedExtra > 0) parts.push(`另外 ${truncatedExtra} 项`);

  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join('、')} 和 ${parts[parts.length - 1]}`;
}

function aggregateToolSummaryVerbs<TMessage extends MessagePresentationToolLike>(
  tools: readonly TMessage[],
): ToolSummaryVerbEntry[] {
  const counter = new Map<ToolSummaryVerb, number>();
  for (const tool of tools) {
    const verb = TOOL_SUMMARY_VERB_BY_LABEL[tool.label] ?? 'used';
    counter.set(verb, (counter.get(verb) ?? 0) + 1);
  }
  return TOOL_SUMMARY_VERB_ORDER
    .filter((verb) => counter.has(verb))
    .map((verb) => ({
      verb,
      count: counter.get(verb)!,
    }));
}

function desktopPlainFoldHeader({ title }: { title: string }): MessageFoldHeaderPresentation {
  return {
    chevronPosition: 'trailing',
    chevronSize: 14,
    defaultExpanded: false,
    iconSize: 14,
    summaryCount: 0,
    subtitle: null,
    title,
    variant: 'plain',
  };
}

function desktopTodoFoldHeader({
  summaryCount,
  title,
}: {
  summaryCount: number;
  title: string;
}): MessageFoldHeaderPresentation {
  return {
    chevronPosition: 'leading',
    chevronSize: 14,
    defaultExpanded: true,
    iconSize: 16,
    summaryCount,
    subtitle: null,
    title,
    variant: 'card',
  };
}

function messageBubbleDensity({
  body,
  hasAuxiliaryContent,
  isStreaming,
  kind,
}: {
  body: string;
  hasAuxiliaryContent: boolean;
  isStreaming: boolean;
  kind: string;
}): MessageBubbleDensity {
  if (kind === 'system' || hasAuxiliaryContent || body.length > 520) return 'rich';
  if (isStreaming || body.length > 140 || body.includes('\n')) return 'standard';
  return 'compact';
}

function countItemDiffs<TMessage extends MessagePresentationToolLike>(
  item: MessageRenderItem<TMessage> | MessageRenderWorkChildItem<TMessage>,
): number {
  if (item.type === 'tool_group') {
    return item.tools.filter((tool) => !!tool.diff).length;
  }
  if (item.type === 'work_group') {
    return item.children.reduce((sum, child) => sum + countItemDiffs(child), 0);
  }
  return 0;
}

function readRecordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyStringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isErrorRecord(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    if (record.ok === false || record.success === false) return true;
    const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
    if (status === 'error' || status === 'failed' || status === 'failure') return true;
    return ['error', 'errors', 'exception', 'stderr'].some((key) => {
      const raw = record[key];
      return typeof raw === 'string' ? raw.trim().length > 0 : raw !== undefined && raw !== null;
    });
  } catch {
    return false;
  }
}
