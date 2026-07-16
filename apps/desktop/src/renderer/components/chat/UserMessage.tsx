/**
 * UserMessage
 * ---------------------------------------------------------------------------
 * Right-aligned chat bubble for user messages.
 *
 * F-MSG-1: user message styling
 * - Card background + 1px Board border + 12px radius
 * - Max width 520px, right-aligned
 * - Inline chips for `@file`, `@dir/`, `@.claude/agents/x.md`, `/command`
 *
 * F-MSG-IMG: image attachments rendered above text bubble (rounded-12, max-w 280px)
 * F-MSG-DOC: document paths rendered inline as @path chips in text content
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, ChevronUp, File as FileIcon, FileText, Folder as FolderIcon, MessageSquareQuote, Sparkles, Target } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { cn } from '@/lib/utils';
import { resolveLocalPath, resolveLocalPathSmart, toLocalFileUrl } from '@/lib/localPathResolver';
import { isBrowserOpenablePath } from '../../../shared/browserOpenableExts';
import { toast } from '@/lib/toast';
import { shouldOpenTextLightboxForOrigin } from '@/lib/filePreview';
import { saveDraft as saveComposerDraft } from '@/lib/composerDraftStore';
import { emitPatch as emitSessionPatch } from '@/lib/sessionsBus';
import { makerChatStore } from '@/lib/makerChatStore';
import type { Session, AgentKind as RendererAgentKind, MessageAutomationOrigin } from '@/lib/ccAgent.types';
import { buildRewindDraftAttachments } from '@/lib/rewindDraftAttachments';
import { useAgentCapabilities, type AgentKind as MakerAgentKind } from '@/hooks/useAgentCapabilities';
import { useGitSafetyAutoSnapshotEnabledForDevice } from '@/hooks/useGitSafetySettings';
import { useChatSessionFile } from './ChatSessionFileContext';
import { isRemoteFileOrigin, originDeviceId, toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import { rewriteToRemoteMediaOrigin } from '../../../shared/remoteMediaUrl';
import { ImageLightbox } from './ImageLightbox';
import {
  parseLeadingBlockquotes,
  quoteSourceDisplayLabel,
  type ChatQuote,
} from '@/lib/chatQuotes';
import { ChatImageView } from './ChatImageView';
import { TextLightbox } from './TextLightbox';
import { MessageActionBar } from './MessageActionBar';
import { ErrorMessageCard } from './ErrorMessageCard';
import { useForkAtMessage, textToTiptapDoc } from './useForkAtMessage';
import { useSessionNavigationMode } from '@/features/cc-agent/embeddedSessionNavigation';
import { RewindPreviewDialog } from './RewindPreviewDialog';
import { UserMessageEditBox } from './UserMessageEditBox';
import HookTaskCard from './HookTaskCard';
import { useFileChipContextMenu } from './useFileChipContextMenu';
import {
  AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD,
  mayExceedVisualLineThreshold,
  useUserMessageAutoCollapse,
} from './userMessageCollapse';
import { findLinkifyMatches } from './userMessageLinkify';
import { SessionLinkChip } from './SessionLinkChip';
import { ProjectLinkChip } from './ProjectLinkChip';
import { buildSessionMessageDeepLink } from '@/lib/deepLink';
import { MENTION_TOKEN_SPLIT, parseMentionToken } from '@/lib/mentionRefFormat';
import { parseGhostCommandWord, splitGhostDirective } from '@/cindy-brain/ghostCommand';
import {
  GhostFulfillmentContext,
  GhostSummonCard,
  type GhostSummonDisplay,
} from './GhostSummonCard';
import { AutomationOriginBadge } from './AutomationOriginBadge';

/**
 * image-local-cache: a user-message image can be in two shapes:
 *   - cached (xdt-image:// url) — the persistent, primary form
 *   - F6 fallback (in-memory base64) — only until session restart
 */
type UserImageItem =
  | {
      url: string;
      mimeType: string;
      originalName: string;
      /** 非破坏性标注(见 imageRef.ts):原图 url + 矢量笔迹,历史图可再编辑。 */
      annotationSourceUrl?: string;
      annotationStrokes?: Array<{ points: Array<{ x: number; y: number }> }>;
    }
  | { base64: string; mimeType: string; originalName?: string };

type OrcaCommunicationContent = {
  orcaSource: 'lead' | 'worker';
  content: string;
};

interface UserMessageProps {
  /** F2: session cwd used to resolve relative paths in inline @-chip refs.
   *  Stable per-session — only changes on session switch. */
  workingDir: string;
  content: string;
  /** chat-text-quote:content 开头 blockquote 为引用功能产出(胶囊化渲染判据)。 */
  quotesEncoded?: boolean;
  images?: UserImageItem[];
  files?: Array<{ name: string; path: string }>;
  /** ISO timestamp for the smart-time display in the hover action bar. */
  createdAt?: string;
  /** Active session id; required to wire the Fork button. When omitted,
   *  the Fork button is not rendered. */
  sessionId?: string;
  /** Owning agent kind (renderer 短名 'cc' | 'codex') — gates Fork/Rewind icon
   *  visibility via capabilities. Codex rewind additionally requires the Git
   *  safety snapshot setting because file rewind depends on savepoint commits. */
  agentKind?: RendererAgentKind;
  /** Owning session's remote SSH host id (null for local). Remote cc daemon
   *  sessions don't support the query-rebuild that Fork/Rewind need yet (MVP),
   *  so both actions are hidden when this is set. */
  remoteHostId?: string | null;
  /** clientId of this message (== messages.client_id in DB). Backend's
   *  fork IPC takes (sessionId, clientId) to locate the fork point. When
   *  omitted, the Fork button is not rendered. */
  messageClientId?: string;
  /** Whether this session currently has an in-flight SDK turn. Rewind still
   *  needs an idle live query, while fork is allowed from stable history. */
  sessionRunning?: boolean;
  /** Host-side delivery marker. Same-turn steer user rows are unstable while running. */
  delivery?: 'turn' | 'steer';
  /** True iff this is the first user message in the visible list. Both
   *  Fork and Rewind buttons are hidden — fork-at-first 等价于复制整条
   *  session（无意义），rewind-at-first 后端会抛 NO_PRIOR_ASSISTANT。 */
  isFirstUserMessage?: boolean;
  /** True iff this is the LAST user message in the full message list.
   *  edit-last-message: 只有最后一条 user 消息显示编辑入口(编辑 = rewind 到
   *  这条 + 重发,更早的消息编辑会静默丢弃后续轮次,v1 不开放)。 */
  isLastUserMessage?: boolean;
  /** scheduler 注入的消息来源标记;存在时在气泡上方渲染"由自动化任务发送"标签。 */
  automationOrigin?: MessageAutomationOrigin;
  /** Hook 来源元数据;存在时渲染左对齐 Cindy 署名任务卡片(替代右对齐气泡)。 */
  hookSource?: { im: string; channelName?: string | null; userText?: string; threadContext?: Array<{ author: string; text: string; isBot?: boolean }> };
  /** /goal 目标设定/更新标记:在气泡上方渲一个「目标 / 目标已更新」徽标。 */
  goalBadge?: { updated: boolean };
  /** 订阅槽①:本条消息被意识钩子拦下(未发出)。存在时气泡下方渲一条 error
   *  红条(内容 = 意识返回文本,直接显示);用户用编辑铅笔改了重发。 */
  blockedByGhost?: { ghostId: string; ghostName: string; reason: string };
}

export function shouldBlockUserFork(
  sessionRunning?: boolean,
  delivery?: 'turn' | 'steer',
): boolean {
  return sessionRunning === true && delivery === 'steer';
}

function parseOrcaCommunicationContent(content: string): OrcaCommunicationContent | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.orcaSource !== 'lead' && record.orcaSource !== 'worker') return null;
    if (typeof record.content !== 'string') return null;
    return {
      orcaSource: record.orcaSource,
      content: record.content,
    };
  } catch {
    return null;
  }
}

// Chip styles shared with MentionChipNode (same CSS variables)
const chipClass = cn(
  'inline-flex items-center gap-[3px] px-[5px] py-[0.5px]',
  'rounded-[4px] border',
  'bg-[var(--chat-input-chip-bg)]',
  'border-[var(--chat-input-chip-border)]',
  'text-[var(--chat-input-chip-text)]',
  'font-mono text-[13px] leading-[18px] whitespace-nowrap',
  'relative top-[-1px] align-middle -my-[1px]',
);
const iconClass = 'shrink-0 text-[var(--chat-input-chip-icon)]';

/**
 * UserFileChip — `@file` chip in a user message. Left click opens TextLightbox
 * via onClick; right click opens the shared file-chip menu (copy / copy path /
 * reveal in folder). Extracted into a component so the hook can run; renderContent
 * itself isn't a React component and can't call hooks directly.
 */
function UserFileChip({
  refText,
  fileName,
  workingDir,
  onClick,
}: {
  refText: string;
  fileName: string;
  workingDir: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void | Promise<void>;
}) {
  // remote 会话:fs:resolve-path 打的是本机 fs,对远程 workdir 恒 none——
  // 按 workdir 风格直接 join(与 useResolvedMarkdownTarget 的 remote 分支同策)。
  const chipRemote = isRemoteFileOrigin(useChatSessionFile().origin);
  const ctxMenu = useFileChipContextMenu({
    getAbsPath: async () => {
      if (chipRemote) return resolveLocalPath(refText, workingDir);
      const r = await resolveLocalPathSmart(refText, workingDir);
      if (r.status === 'unique') return r.absPath;
      if (r.status === 'multiple') return r.candidates[0] ?? refText;
      return r.fallbackAbsPath;
    },
    canOpenInBrowser: isBrowserOpenablePath(refText),
  });
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        onContextMenu={ctxMenu.onContextMenu}
        className={cn(
          chipClass,
          'text-left whitespace-normal break-all',
          'cursor-pointer transition-colors',
          'hover:bg-[var(--cmd-palette-item-hover)]',
        )}
      >
        <FileIcon size={12} className={iconClass} />
        {fileName}
      </button>
      {ctxMenu.menu}
    </>
  );
}

/**
 * Render a plain-text segment, converting:
 *   - http(s) URLs into <a> that open in the system browser
 *   - bare absolute image paths into clickable buttons that open the
 *     ImageLightbox via the xdt-file:// custom protocol
 * Everything else is returned as-is string fragments.
 */
function renderTextWithLinks(
  text: string,
  keyPrefix: string,
  onImageClick: (xdtFileUrl: string) => void,
): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  const matches = findLinkifyMatches(text);
  let lastIndex = 0;

  for (const match of matches) {
    if (match.index > lastIndex) {
      result.push(text.slice(lastIndex, match.index));
    }
    if (match.kind === 'url') {
      const url = match.text;
      result.push(
        <a
          key={`${keyPrefix}-url-${match.index}`}
          href={url}
          className="text-[var(--msg-link)] hover:underline cursor-pointer"
          onClick={(e) => {
            e.preventDefault();
            window.electronAPI.openExternal(url);
          }}
        >
          {url}
        </a>,
      );
    } else if (match.kind === 'session') {
      // 会话深链 → chip(显式 label / 标题 / 短 ID),点击跳会话、带锚点定位
      // 消息。`[标题](深链)` markdown 形式(输入框粘贴 chip 化的序列化产物)
      // 带显式 label,SessionLinkChip 优先展示、不查库。
      result.push(
        <SessionLinkChip
          key={`${keyPrefix}-session-${match.index}`}
          href={match.href}
          label={match.label}
        />,
      );
    } else if (match.kind === 'project') {
      // 项目深链 → chip(显式 label / 目录名),点击聚焦侧边栏 project 节点。
      result.push(
        <ProjectLinkChip
          key={`${keyPrefix}-project-${match.index}`}
          href={match.href}
          label={match.label}
        />,
      );
    } else {
      const p = match.text;
      result.push(
        <button
          key={`${keyPrefix}-img-${match.index}`}
          type="button"
          onClick={() => onImageClick(toLocalFileUrl(p))}
          className="text-[var(--msg-link)] hover:underline cursor-pointer break-all"
        >
          {p}
        </button>,
      );
    }
    lastIndex = match.index + match.length;
  }

  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }
  return result;
}

/**
 * Heuristic: does a `@ref` look like a real file/dir/agent path?
 *
 * Positive signals (any one is enough):
 *   - Contains `/`           → looks like a path  (e.g. `src/App.tsx`)
 *   - Has a file extension   → looks like a file  (e.g. `App.tsx`)
 *   - Starts with `.`        → dotfile / dotdir   (e.g. `.env`)
 *
 * Plain words like `@someone`, `@123131312`, `@param` → false.
 */
function looksLikePath(ref: string): boolean {
  if (ref.includes('/')) return true;
  if (/\.\w{1,10}$/.test(ref)) return true;
  if (ref.startsWith('.')) return true;
  return false;
}

/**
 * Heuristic: does a `/word` at line start look like a real command name?
 *
 * Must start with a letter, contain only letters/digits/hyphens/underscores,
 * and be reasonably short (≤ 30 chars). This matches real commands like
 * `compact`, `sivi-halt`, `help` but rejects paths like `/etc/passwd` and
 * noise like `/1312312`.
 */
function looksLikeCommand(word: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,29}$/.test(word);
}

/**
 * Parse serialized message content and render @mentions and /commands as
 * inline chips — but only when they look like real file paths or command
 * names. Plain `@word` and arbitrary `/text` are left as normal text.
 *
 * Chip patterns:
 *   @.claude/agents/name.md  → agent chip (sparkles + name)
 *   @path/to/dir/            → dir chip (folder + dirname/)
 *   @path/to/file.ext        → file chip (file + basename) — clickable button
 *   /command (at line start) → slash chip (no icon, /command)
 *
 * Plain text segments are further scanned for URLs, which are rendered as
 * clickable links that open in the system default browser.
 *
 * F2: file chips are rendered as `<button>` (not `<span>`) so they can open
 * TextLightbox on click. The dir/agent/slash chips remain `<span>` — they
 * have no click target in this iteration.
 *
 * @param content       The user message content to parse.
 * @param workingDir    Session cwd; used to resolve relative refs.
 * @param onFileChipClick  Called when a file chip is clicked. Receives the
 *                          resolved abs path, the displayed file name, and
 *                          the clicked button element (for focus restoration
 *                          when the lightbox closes — F6).
 */
function renderContent(
  content: string,
  workingDir: string,
  onFileChipClick: (abs: string, name: string, btn: HTMLButtonElement) => void | Promise<void>,
  onImageClick: (xdtFileUrl: string) => void,
  t: TFunction,
  /** remote 会话:@-chip 点击跳过本机 smart resolve,按 workdir 风格直接 join。 */
  remoteJoin = false,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const lines = content.split('\n');

  for (let li = 0; li < lines.length; li++) {
    if (li > 0) nodes.push('\n');
    let line = lines[li];

    // Check for /command at line start — only if it looks like a real command
    const slashMatch = line.match(/^\/(\S+)/);
    if (slashMatch && looksLikeCommand(slashMatch[1])) {
      nodes.push(
        <span key={`s-${li}`} className={chipClass}>
          /{slashMatch[1]}
        </span>,
      );
      line = line.slice(slashMatch[0].length);
    }

    // Parse @mentions in the remaining line. MENTION_TOKEN_SPLIT also captures
    // the `@"path with spaces"` quoted form so含空格的文件名不再被空格截断。
    const parts = line.split(MENTION_TOKEN_SPLIT);
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      if (!part) continue;

      if (part.startsWith('@')) {
        const { ref } = parseMentionToken(part); // 去 @ 与外层引号、反转义

        // @ embedded mid-word (e.g. email `user@xd.com`) → plain text.
        // A real mention is always preceded by whitespace or sits at line start.
        const prev = parts[pi - 1];
        if (prev && prev.length > 0 && !/\s$/.test(prev)) {
          nodes.push(...renderTextWithLinks(part, `${li}-${pi}`, onImageClick));
          continue;
        }

        // Only render as chip if it looks like a real path
        if (!looksLikePath(ref)) {
          // Not a path — render as plain text
          nodes.push(...renderTextWithLinks(part, `${li}-${pi}`, onImageClick));
          continue;
        }

        const key = `${li}-${pi}`;

        if (ref.startsWith('.claude/agents/')) {
          const name = ref.replace('.claude/agents/', '').replace(/\.md$/, '');
          nodes.push(
            <span key={key} className={chipClass}>
              <Sparkles size={12} className={iconClass} />
              {name}
            </span>,
          );
        } else if (ref.endsWith('/')) {
          // 同时按 / 和 \ 拆分，否则 Windows 绝对路径（drop 文件夹时常见，
          // 如 `C:\Users\foo\bar\/`）会被当成单段，dirName 退化成完整路径，
          // chip 的 whitespace-nowrap 会把气泡撑变形。
          const dirName =
            ref.slice(0, -1).split(/[\\/]/).filter(Boolean).pop() || ref;
          nodes.push(
            <span key={key} className={chipClass}>
              <FolderIcon size={12} className={iconClass} />
              {dirName}/
            </span>,
          );
        } else {
          const fileName = ref.split(/[\\/]/).pop() || ref;
          // v7: 右键菜单(复制 / 复制文件路径 / 打开文件所在目录) 由 UserFileChip 提供。
          nodes.push(
            <UserFileChip
              key={key}
              refText={ref}
              fileName={fileName}
              workingDir={workingDir}
              onClick={async (e) => {
                // Capture currentTarget before await — React pools events and
                // by the time the IPC resolves, currentTarget is null.
                const btn = e.currentTarget;
                if (remoteJoin) {
                  // remote:本机 BFS 无意义,join 出远端绝对路径,存在性由
                  // 点击后的远程取回链路兜底。
                  await onFileChipClick(resolveLocalPath(ref, workingDir), fileName, btn);
                  return;
                }
                // markdown-monorepo-resolve: smart resolve so a chip like
                // `@src/App.tsx` resolves to the right sub-package even
                // though session.workingDir points at the workspace root.
                const result = await resolveLocalPathSmart(ref, workingDir);
                if (result.status === 'multiple') {
                  toast.error(t('chat.markdownRenderer.duplicateFiles', { count: result.candidates.length }));
                  return;
                }
                const abs =
                  result.status === 'unique'
                    ? result.absPath
                    : result.fallbackAbsPath;
                await onFileChipClick(abs, fileName, btn);
              }}
            />,
          );
        }
      } else {
        nodes.push(...renderTextWithLinks(part, `${li}-${pi}`, onImageClick));
      }
    }
  }
  return nodes;
}

// 用户上传图统一走 ChatImageView('user-attached' variant),把样式规则、
// click→ImageLightbox、error→ImageMissingPlaceholder 都收敛到一处。
// 老 UserImageItemView 已迁出,见 ChatImageView.tsx。

export function UserMessage({
  workingDir,
  content,
  quotesEncoded,
  images,
  files,
  createdAt,
  sessionId,
  agentKind,
  remoteHostId,
  messageClientId,
  sessionRunning,
  delivery,
  isFirstUserMessage,
  isLastUserMessage,
  automationOrigin,
  hookSource,
  goalBadge,
  blockedByGhost,
}: UserMessageProps) {
  const { t } = useTranslation();
  // Capability gate: 没传 agentKind (调用方未升级) → 默认两者都允许 (兼容旧路径)
  // 传了 agentKind → 按 capabilities.fork/rewind.supported 决定 icon 显示
  // renderer 'cc' ↔ maker 'claude-code' 别名映射 (DB / Session 用 'cc', maker IPC 用 'claude-code')
  const makerKind: MakerAgentKind = agentKind === 'codex' ? 'codex' : 'claude-code';
  // device-link 远程会话:fork/rewind 能力按被控端读(本机会话 deviceId undefined,行为不变)。
  // 媒体来源(device/ssh)用于把附件/文件预览 URL 改写到 xdt-remote-media://(入方向媒体)。
  // 取自 ChatSessionFileContext(MessageStream 顶层订阅式构造,deviceId 迟到注册时
  // context 更新会穿透 memo 触发重渲,替代旧的 render 期一次性读取)。
  const sessionFileCtx = useChatSessionFile();
  const remoteDeviceId = originDeviceId(sessionFileCtx.origin);
  const gitSafetyAutoSnapshotEnabled = useGitSafetyAutoSnapshotEnabledForDevice(remoteDeviceId);
  const remoteMediaOrigin = useMemo(
    () => toRemoteMediaOrigin(sessionFileCtx.origin, sessionFileCtx.workingDir),
    [sessionFileCtx],
  );
  const { capabilities } = useAgentCapabilities(makerKind, remoteDeviceId);
  // 远端 cc daemon 会话暂不支持 Fork/Rewind 依赖的 query rebuild (MVP),
  // remoteHostId 非空时直接关掉这两个能力, 避免点了落到后端错误。
  const isRemote = Boolean(remoteHostId);
  const codexRewindEntryAllowed =
    agentKind !== 'codex' || gitSafetyAutoSnapshotEnabled;
  const forkSupported = !isRemote && (!agentKind || (capabilities?.fork?.supported ?? true));
  const rewindSupported =
    codexRewindEntryAllowed &&
    !isRemote &&
    (!agentKind || (capabilities?.rewind?.supported ?? true));

  const hasImages = images && images.length > 0;
  const hasFiles = files && files.length > 0;
  // F5.7: Lightbox state for user message images (same pattern as MarkdownRenderer)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // text-lightbox F1: Chip-Row entry — clicking a file chip opens TextLightbox.
  const [textLightboxFile, setTextLightboxFile] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [orcaExpanded, setOrcaExpanded] = useState(false);
  const [longMessageExpanded, setLongMessageExpanded] = useState(false);
  // text-lightbox F6: ref to the chip currently driving the lightbox so
  // close can return focus to it (only one lightbox at a time per message).
  const activeFileChipRef = useRef<HTMLButtonElement | null>(null);

  // text-lightbox F1 replaces the old `@path` inline prepend. Files are now
  // rendered as a dedicated Chip-Row above the text bubble (per cc-agent-view
  // pen DLGJ9 / s2N4G). The text bubble itself only renders user-typed content.
  const orcaCommunication = parseOrcaCommunicationContent(content);
  const rawDisplayContent = orcaCommunication?.content ?? content;
  // hook 消息: 卡片正文优先用 source.userText(干净原文, 与 prompt 分离);
  // 过渡期消息(有 hookSource 无 userText)回退正则剥 <thread_context> 块。
  const displayContent = hookSource
    ? (hookSource.userText ??
        rawDisplayContent
          .replace(/^<thread_context>[\s\S]*?<\/thread_context>\s*(?:\(thread 历史中的.*?\)\s*)?/m, '')
          .trim())
    : rawDisplayContent;
  // ghost-summon-card:意识指令/提示的机器追加段从气泡正文尾部剥离,交给
  // GhostSummonCard 渲染(splitGhostDirective 与 expandGhostCommand 同模板,
  // 对不上模板按普通文本原样显示)。copy / fork / rewind / 编辑预填全部用
  // 剥离后的正文——这些路径重发都走发送期再展开,带着旧指令会叠加双份。
  // orca / hook 消息不经意识展开,跳过解析。
  const ghostSplit =
    orcaCommunication || hookSource ? null : splitGhostDirective(displayContent);
  const ghostDirective = ghostSplit?.directive ?? null;
  const ghostBody = ghostSplit?.body ?? displayContent;
  // chat-text-quote:开头的 blockquote 是"选中文字引用"(见 lib/chatQuotes),
  // 渲染成 Codex 风格的引用预览块 + "N selections" 胶囊;气泡正文只渲余下部分。
  // 仅对引用功能产出的消息(quotesEncoded 标志,见 imageRef.ts)启用胶囊化
  // 解析;历史消息与用户手打的 markdown 引用原样渲染,存量呈现不变。
  const { quotes: leadingQuotes, body: bubbleBody } =
    orcaCommunication || !quotesEncoded
      ? { quotes: [] as ChatQuote[], body: ghostBody }
      : parseLeadingBlockquotes(ghostBody);
  // $指令 开头且确认命中意识时,消息走"合并形态":不渲文字气泡,prompt
  // (剥掉指令 token 的余文)收进召唤卡卡身;普通消息里的 $word 不受影响。
  const ghostCmdWord =
    ghostDirective?.kind === 'command' ? parseGhostCommandWord(bubbleBody) : null;
  // 触发符恒为 1 个字符($ 或全角变体),token = 触发符 + 指令词。
  const ghostCmdToken = ghostCmdWord ? bubbleBody.slice(0, 1 + ghostCmdWord.length) : null;
  const ghostPromptBody = ghostCmdToken ? bubbleBody.slice(ghostCmdToken.length).trim() : '';
  // 软提示兑现(语义调用):本条消息触发的那一轮 AI 真调了被提及的意识时,
  // 与硬指令走同一合并形态——不渲文字气泡,整条正文作为 prompt 收进召唤卡,
  // 语义调用与 $ 显式召唤最终渲染一致。判据来自 GhostFulfillmentContext
  // (MessageStream 从会话历史现算,重启幂等)。
  const ghostFulfillment = useContext(GhostFulfillmentContext);
  const ghostFulfilledIds = messageClientId ? ghostFulfillment.get(messageClientId) : undefined;
  const ghostMentionFulfilled =
    ghostDirective?.kind === 'mention' &&
    Boolean(ghostFulfilledIds && ghostDirective.ghosts.some((g) => ghostFulfilledIds.has(g.ghostId)));
  // 语义自主召唤:消息一个触发词都没命中(无任何追加段),AI 本轮仍真调了
  // ghost_call → 合成 semantic 展示数据,同样走合并大卡(与硬指令/兑现软
  // 提示渲染一致)。orca / hook 消息不参与(它们本就不经意识展开)。
  const ghostSemanticDisplay: GhostSummonDisplay | null =
    !ghostDirective &&
    !orcaCommunication &&
    !hookSource &&
    ghostFulfilledIds &&
    ghostFulfilledIds.size > 0
      ? { kind: 'semantic', ghostIds: [...ghostFulfilledIds] }
      : null;
  // 召唤卡的最终展示数据(追加段解析优先;没有追加段才可能是 semantic)。
  const ghostCardDisplay: GhostSummonDisplay | null = ghostDirective ?? ghostSemanticDisplay;
  // 兑现驱动的合并(软提示兑现 / 语义召唤)对自动化任务消息豁免:模板化
  // 调度 prompt 每轮重复出现,靠专门的低阈值收起反刷屏(见 collapseThreshold),
  // 合并进卡身会绕过收起、每轮全文刷屏——自动化消息保留气泡 + 收起,召唤卡
  // 照渲但不吞正文(subagent review P1)。$指令 合并不受影响(用户显式点名)。
  const ghostFulfillMerge =
    !automationOrigin && (ghostMentionFulfilled || ghostSemanticDisplay !== null);
  // 合并形态总开关:$指令 / 软提示兑现 / 语义自主召唤,都是"卡片即消息"。
  const ghostMergedForm = Boolean(ghostCmdToken) || ghostFulfillMerge;
  // 合并形态下收进卡身的 prompt 原文:硬指令剥 $token 余文;其余整条正文。
  const ghostCardPromptBody = ghostCmdToken
    ? ghostPromptBody
    : ghostFulfillMerge
      ? bubbleBody
      : '';
  // 长消息收起以真实排版为准:粗筛命中的消息在气泡里挂隐藏镜像节点实测
  // 视觉行数,窗口缩放 / 侧栏开合导致气泡宽度变化时由 ResizeObserver 重算。
  // 自动化任务注入的消息(模板化调度 prompt,每轮重复出现)用更低的收起
  // 阈值,收起后也只留 3 行(手打消息 14 行阈值 / 收起留 10 行不变)。
  const collapseThreshold = automationOrigin
    ? AUTOMATION_USER_MESSAGE_VISUAL_LINE_THRESHOLD
    : LONG_USER_MESSAGE_VISUAL_LINE_THRESHOLD;
  // 合并形态($指令 / 软提示兑现 / 语义召唤)不渲文字气泡,镜像测量无处挂载,直接关掉。
  const collapseMeasureEnabled =
    !orcaCommunication &&
    !hookSource &&
    !ghostMergedForm &&
    mayExceedVisualLineThreshold(bubbleBody, collapseThreshold);
  const { mirrorRef: collapseMirrorRef, shouldCollapse: shouldCollapseLongMessage } =
    useUserMessageAutoCollapse(bubbleBody, collapseMeasureEnabled, collapseThreshold);
  const longMessageCollapsed = shouldCollapseLongMessage && !longMessageExpanded;

  // message-actions hover state — raw hover boolean, no debounce here.
  // The bar component owns its own fade lifecycle (250ms trailing debounce
  // + CSS opacity transition) so quick re-enters interpolate smoothly.
  const [hovered, setHovered] = useState(false);

  // copy text per V1.2: original text + (if files) "\n\n附件：a.md, b.md"
  // ghost-summon-card:copy 给用户的是"他自己的话"(剥离机器追加段);
  // 追加段原文在卡片展开区可查可选中。
  const copyText = hasFiles
    ? `${ghostBody}\n\n${t('chat.userMessage.attachmentPrefix')}${files!.map((f) => f.name).join(', ')}`
    : ghostBody;

  // fork-from-here: only wire when both sessionId + messageClientId are
  // present (older code paths that render UserMessage without these props
  // simply won't show the Fork button). 流程收敛在 useForkAtMessage —
  // user 消息分叉把提问文本预填进新会话 composer。
  // 预填用解析后的 body + quotes(非 quotesEncoded 消息 leadingQuotes 恒空、
  // bubbleBody === displayContent,行为不变):引用以草稿态还原成胶囊,重发
  // 时 ChatInput 重新编码并带上 quotesEncoded,不丢标志。
  const handleFork = useForkAtMessage({
    sessionId,
    messageClientId,
    forkBlocked: shouldBlockUserFork(sessionRunning, delivery),
    draftText: bubbleBody,
    draftQuotes: leadingQuotes,
  });

  // 第一条 user 消息：fork 出来等价于复制整条 session（fork 点之前没东西），藏掉。
  // 同时按 capabilities.fork.supported gate (Codex 现支持; 未来若 agent 不支持自动隐藏)。
  const navigationMode = useSessionNavigationMode();
  const canFork =
    navigationMode === 'route-owner' &&
    Boolean(sessionId && messageClientId) &&
    !isFirstUserMessage &&
    forkSupported &&
    !orcaCommunication &&
    !hookSource;

  // ── rewind ──────────────────────────────────────────────────────────────
  // Dialog open state lives here (UserMessage owns the in-flight period —
  // dialog opens → preview dryRun → user confirm → commit → close, the whole
  // span counts as "rewinding" for the action-bar Loader2). Reset on close.
  const [rewindOpen, setRewindOpen] = useState(false);

  const handleRewind = useCallback(() => {
    if (!sessionId || !messageClientId) return;
    if (sessionRunning) {
      toast.error(t('chat.userMessage.rewindBusy'));
      return;
    }
    setRewindOpen(true);
  }, [sessionId, messageClientId, sessionRunning, t]);

  const handleRewindCommitted = useCallback(
    (session: Session) => {
      if (!sessionId) return;
      // Pre-fill composer with the rewound user message text — same UX as fork.
      // Rewind soft-deletes this row server-side (rewind_at set), so on next
      // reload it disappears from the list; the composer keeps the draft so
      // the user can edit and re-send.
      // 同 fork 预填:body 进文本、引用还原草稿态胶囊(见 handleFork 处注释)。
      const draftText = textToTiptapDoc(bubbleBody);
      const draftAttachments = buildRewindDraftAttachments({ images, files });
      if (draftText || draftAttachments.length > 0 || leadingQuotes.length > 0) {
        saveComposerDraft(sessionId, {
          text: draftText,
          attachments: draftAttachments,
          ...(leadingQuotes.length > 0 ? { quotes: leadingQuotes } : {}),
        });
      }
      // Patch sidebar: tokens reset, sdkSessionId may have changed, bump
      // updatedAt so this session sorts back to top.
      emitSessionPatch(sessionId, {
        sdkSessionId: session.sdkSessionId,
        contextTokens: 0,
        contextWindow: 0,
        updatedAt: session.updatedAt,
        userSendAt: session.userSendAt,
      });
      // Force chat store to re-fetch messages (server filters rewind_at).
      makerChatStore.reloadMessages(sessionId);
    },
    [sessionId, bubbleBody, leadingQuotes, images, files],
  );

  // 第一条 user 消息没有可作为锚点的 prior assistant uuid → 后端必抛
  // NO_PRIOR_ASSISTANT。直接藏掉按钮，避免无效点击。
  // 同时按 capabilities.rewind.supported gate；Codex 入口还要用户显式开启 Git safety。
  const canRewind = Boolean(sessionId && messageClientId) && !isFirstUserMessage && rewindSupported && !orcaCommunication && !hookSource;

  // ── edit-last-message ──────────────────────────────────────────────────
  // 编辑 = rewind 到本条 + 用编辑后的文本立即重发(见 UserMessageEditBox)。
  // 只在最后一条 user 消息开放;能力门控与 Rewind 完全一致(编辑走同一条
  // commit 链路,rewind 不可用则编辑必然也不可用),首条消息同样因缺
  // prior assistant 锚点而隐藏。进入编辑态零副作用,取消原样恢复。
  const [editing, setEditing] = useState(false);
  // 被意识钩子拦下的消息(订阅槽①):从未落库、无 turn 可 rewind,编辑走
  // 普通重发(onCommitOverride),故可编辑条件与 rewind 无关——只要有
  // session/clientId 就能改了重发。
  const isBlocked = Boolean(blockedByGhost);
  const canEdit = isBlocked
    ? Boolean(sessionId && messageClientId)
    : canRewind && Boolean(isLastUserMessage);

  // 中断运行中的 turn——Stop 语义与输入框的 Stop 按钮完全一致
  // (useCCAgentChat.stopSession):有排队消息时 keepQueue+pauseQueue(停当前 +
  // 暂停整个队列,防止 stop 落地后队列头在 rewind 之前抢跑新 turn),否则普通 stop。
  const stopForEdit = useCallback(() => {
    if (!sessionId) return;
    const snap = makerChatStore.getSnapshot(sessionId);
    if (snap.pendingQueue.length > 0) {
      makerChatStore.stopSession(sessionId, { keepQueue: true, pauseQueue: true });
    } else {
      makerChatStore.stopSession(sessionId);
    }
  }, [sessionId]);

  // 点编辑 = 立即中断运行中的 turn(产品决策,对齐 2026-07 的 Codex 调研:
  // 用户点编辑的意图就是"停下来我要改",且 interrupt 终止性、无恢复原语,
  // 取消编辑后 AI **不会**继续工作——Codex 同语义,用户已知悉接受)。
  // 发送侧不依赖这里的 stop 已完成:EditBox 会等 sessionRunning 翻 false 再
  // 提交(含超时兜底 + 发送时再补一次 stop 的保险),两端解耦。
  //
  // 队列门槛:有排队中的消息时拒绝进入编辑(toast 说明)。排队消息是针对
  // rewind 前的旧上下文写的,而编辑重发只会追加到 paused 队列尾部——Continue
  // 后陈旧消息会先于编辑内容重放进已被裁剪的对话(顺序反转)。与其静默产生
  // 错乱时间线,不如让用户先发送/清空队列再编辑。点击时读快照即可(非响应式):
  // mid-edit 队列突增的竞态由 commitEditAndResend 的同名硬守卫兜底。
  const handleEdit = useCallback(() => {
    if (sessionId && makerChatStore.getSnapshot(sessionId).pendingQueue.length > 0) {
      toast.error(t('chat.userMessage.editQueueNotEmpty'));
      return;
    }
    if (sessionRunning) stopForEdit();
    setEditing(true);
  }, [sessionId, sessionRunning, stopForEdit, t]);

  // 稳定引用:内联箭头会让 EditBox 的 doCommit(依赖 onSent)每次父组件
  // 重渲都重建,连带"等待停止接力" effect 无谓重跑(bot review 指出)。
  const exitEditing = useCallback(() => setEditing(false), []);

  // 编辑期间会话来了新消息(自动化任务注入等) → 本条不再是最后一条,继续
  // 发送会把那条新消息一起回退掉。直接退出编辑态(文本是从原消息预填的,
  // 退出无内容损失风险 —— 用户改到一半的文本被放弃,但这是极罕见路径,
  // 保数据正确性优先)。
  useEffect(() => {
    if (editing && !isLastUserMessage) setEditing(false);
  }, [editing, isLastUserMessage]);

  const orcaCardTitle = orcaCommunication?.orcaSource === 'lead'
    ? 'Orca Lead: dispatched task'
    : 'Orca Worker: reported result';

  // If there are images, use vertical layout: images on top, text bubble below, right-aligned
  // If no images, render the text bubble alone, right-aligned (existing behavior)
  return (
    <div
      // data-user-msg-id: PrevMessageJumpChip 的滚动锚点(usePrevUserMessageInView
      // 通过 querySelector 找当前在 viewport 之上的 user 消息,Chip 点击后
      // scrollIntoView 也以此为目标)。messageClientId 缺失时不挂属性,以免
      // querySelector 命中"data-user-msg-id" 空字符串。
      {...(messageClientId ? { 'data-user-msg-id': messageClientId } : {})}
      // 自己发送的消息不显示主动浮出的“添加到对话”；右键菜单仍可添加。
      data-selection-floating-quote-disabled=""
      className={cn('flex w-full', orcaCommunication || hookSource ? 'justify-start' : 'justify-end')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={cn(
        'flex flex-col gap-2',
        orcaCommunication || hookSource
          ? 'w-full max-w-[560px] items-start'
          // 编辑态铺满可用宽度(上限 720px,Codex 同款"气泡展开成编辑器"观感);
          // 附件 chips 行保持右对齐不动。
          : editing
            ? 'w-full max-w-[720px] items-end'
            : 'max-w-[488px] items-end',
      )}
      >
        {orcaCommunication ? (
          <div
            className={cn(
              'w-full rounded-[8px] border border-[var(--msg-tool-card-border)]',
              'bg-[var(--msg-tool-card-bg)] text-[var(--msg-tool-card-text)]',
              'overflow-hidden',
            )}
          >
            <button
              type="button"
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left',
                'text-[13px] font-medium leading-none',
                'hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
              )}
              aria-expanded={orcaExpanded}
              onClick={() => setOrcaExpanded((value) => !value)}
            >
              <Bot size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
              <span className="min-w-0 flex-1 truncate">{orcaCardTitle}</span>
              {orcaExpanded ? (
                <ChevronDown size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
              ) : (
                <ChevronRight size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
              )}
            </button>
            {orcaExpanded && (
              <div className="border-t border-[var(--msg-tool-card-border)] px-3 py-2">
                <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[length:calc(var(--app-code-font-size)_-_2px)] leading-[calc(var(--app-code-font-size)_+_4px)] text-[var(--foreground)]">
                  {displayContent}
                </pre>
              </div>
            )}
          </div>
        ) : hookSource ? (
          <>
            {/* hook 消息: Cindy 署名任务卡片(左对齐), 替代右对齐用户气泡 +
                automation 标签。附件图保持在卡片上方(与普通消息同款渲染)。 */}
            {hasImages &&
              images.map((img, idx) => {
                const isUrlMode = 'url' in img;
                const src = isUrlMode ? img.url : `data:${img.mimeType};base64,${img.base64}`;
                const filename = isUrlMode
                  ? img.originalName
                  : (img.originalName ?? `image-${idx + 1}`);
                return (
                  <ChatImageView
                    key={`img-${idx}`}
                    src={src}
                    filename={filename ?? `image-${idx + 1}`}
                    variant="user-attached"
                    sessionId={sessionId}
                    annotationSourceUrl={isUrlMode ? img.annotationSourceUrl : undefined}
                    annotationStrokes={isUrlMode ? img.annotationStrokes : undefined}
                  />
                );
              })}
            <HookTaskCard
              im={hookSource.im}
              userText={displayContent}
              threadContext={hookSource.threadContext}
            />
          </>
        ) : (
          <>
        {/* 自动化任务注入的消息:气泡上方右对齐渲染来源标签(不进气泡、不入 copyText)。
            点击跳转自动化页并 focus 对应条目(与侧边栏自动化分组"编辑"同款 query
            机制);任务已删除时 SchedulerPage 的 focus 兜底会自动回退到列表首条。 */}
        {automationOrigin && <AutomationOriginBadge automationOrigin={automationOrigin} />}
        {/* /goal 目标设定/更新:气泡上方右对齐渲一个徽标(不进气泡、不入 copyText)。 */}
        {goalBadge && (
          <span
            className="inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{ backgroundColor: 'var(--surface-chip)', color: 'var(--text-secondary)' }}
          >
            <Target size={11} strokeWidth={2} aria-hidden className="shrink-0" />
            <span className="min-w-0 truncate">
              {goalBadge.updated ? t('goal.objectiveBadgeUpdated') : t('goal.objectiveBadge')}
            </span>
          </span>
        )}
        {/* F-MSG-IMG: image attachments above text bubble */}
        {/* image-local-cache: prefer xdt-image:// url; base64 only for F6 fallback. */}
        {/* F5.7: each image is clickable → opens ImageLightbox */}
        {hasImages &&
          images.map((img, idx) => {
            const isUrlMode = 'url' in img;
            const src = isUrlMode ? img.url : `data:${img.mimeType};base64,${img.base64}`;
            const filename = isUrlMode
              ? img.originalName
              : (img.originalName ?? `image-${idx + 1}`);
            // ChatImageView 自包含 ImageLightbox state,无需父组件协调。
            // (UserMessage 自己保留的 lightboxSrc / setLightboxSrc 是给下方
            //  Markdown 链接路径用的,见 line 633 的 (xdtFileUrl) => setLightboxSrc。)
            return (
              <ChatImageView
                key={`img-${idx}`}
                src={src}
                filename={filename ?? `image-${idx + 1}`}
                variant="user-attached"
                sessionId={sessionId}
                annotationSourceUrl={isUrlMode ? img.annotationSourceUrl : undefined}
                annotationStrokes={isUrlMode ? img.annotationStrokes : undefined}
              />
            );
          })}

        {/* text-lightbox F1: Chip-Row above the text bubble.
            Each chip renders the file's basename + file-text icon and opens
            TextLightbox on click. Pill geometry per pen DLGJ9 / s2N4G. */}
        {hasFiles && (
          <div className="flex flex-wrap items-end gap-1.5 justify-end">
            {files.map((f, idx) => (
              // v6: chip 本体不再 hover tooltip — 文件名已显示，点击触发
              //     TextLightbox 看完整内容，tooltip 是冗余噪音。
              <button
                key={`file-${idx}-${f.path}`}
                type="button"
                onClick={async (e) => {
                  // F6 focus return: stash the chip so the lightbox can
                  // restore focus on close.
                  const btn = e.currentTarget;
                  if (!(await shouldOpenTextLightboxForOrigin(sessionFileCtx, f.path))) return;
                  activeFileChipRef.current = btn;
                  setTextLightboxFile({ path: f.path, name: f.name });
                }}
                className={cn(
                  'inline-flex items-center gap-1.5',
                  'h-7 px-2.5 py-1.5',
                  'rounded-[9999px]',
                  'bg-[var(--msg-user-bg)]',
                  'border border-[var(--msg-user-border)]',
                  'text-[13px] font-medium',
                  'text-[var(--msg-user-text)]',
                  'hover:bg-[var(--cmd-palette-item-hover)]',
                  'transition-colors cursor-pointer',
                  'max-w-[280px]',
                )}
              >
                <FileText size={14} className="shrink-0 text-[var(--msg-user-text)]" />
                <span className="truncate">{f.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* edit-last-message: 编辑态原地替换文本气泡 + 操作条(附件 chips 保持
            只读展示在上方);非编辑态走原有渲染。 */}
        {editing && sessionId && messageClientId ? (
          <UserMessageEditBox
            sessionId={sessionId}
            messageClientId={messageClientId}
            initialText={ghostBody}
            images={images}
            files={files}
            workingDir={workingDir}
            quotesEncoded={quotesEncoded}
            sessionRunning={sessionRunning}
            onRequestStop={stopForEdit}
            onCancel={exitEditing}
            onSent={exitEditing}
            {...(isBlocked
              ? {
                  onCommitOverride: (nextText: string) =>
                    makerChatStore.resendBlockedMessage(sessionId, messageClientId, nextText),
                }
              : {})}
          />
        ) : (
          <>
        {/* chat-text-quote(Codex 风格):正文气泡上方只挂一个 "N 处引用" 胶囊,
            引用内容 hover 胶囊才浮出预览(与输入框侧同款交互)。 */}
        {leadingQuotes.length > 0 && (
          <div className="group/msgquote relative inline-flex">
            <span
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]"
              style={{
                borderColor: 'var(--msg-user-border)',
                color: 'var(--text-secondary)',
              }}
            >
              <MessageSquareQuote size={12} strokeWidth={2} aria-hidden className="shrink-0" />
              <span className="min-w-0 truncate">
                {t('chat.quote.selectionCount', { count: leadingQuotes.length })}
              </span>
            </span>
            {/* hover 预览:右对齐锚定(消息列靠右,左锚会溢出视口)。 */}
            <div
              className="pointer-events-none absolute bottom-full right-0 z-30 mb-2 hidden max-h-64 w-80 max-w-[70vw] flex-col gap-2 overflow-hidden rounded-[12px] border p-3 group-hover/msgquote:flex"
              style={{
                backgroundColor: 'var(--surface-elevated)',
                borderColor: 'var(--border-default)',
                boxShadow: 'var(--shadow-menu)',
              }}
            >
              {leadingQuotes.map((quote, idx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 消息内容不可变,index 稳定。
                <span key={idx} className="flex min-w-0 flex-col gap-0.5">
                  <span
                    className="line-clamp-3 whitespace-pre-wrap text-[12px] leading-[1.5] [overflow-wrap:anywhere]"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    “{quote.text}”
                  </span>
                  {quote.sourcePath ? (
                    <span
                      className="inline-flex items-center gap-1 text-[11px]"
                      style={{ color: 'var(--text-tertiary)' }}
                    >
                      <FileText size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
                      <span className="truncate">{quoteSourceDisplayLabel(quote)}</span>
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Text bubble — only render if there is text;合并形态($指令 命中
            意识 / 软提示被兑现 / 语义自主召唤)整条消息由召唤卡承载,
            不再渲文字气泡。 */}
        {bubbleBody.trim() && !ghostMergedForm && (
          <div
            className={cn(
              // overflow-wrap:anywhere（不是 break-words）才能让超长无空格序列
              // 在任意字符处断行，并把内容的 min-content 缩小到一个字符宽。
              // min-w-0 解除 flex item 默认的 min-width:auto，否则父容器的
              // max-w-[488px] 会被超长 token 顶穿。两者缺一不可。
              'relative min-w-0 max-w-full rounded-[12px]',
              'border border-[var(--msg-user-border)]',
              'bg-[var(--msg-user-bg)]',
              'px-4 py-3',
              'text-15 font-normal leading-[1.6]',
              'text-[var(--msg-user-text)]',
              'select-text',
            )}
          >
            {collapseMeasureEnabled && (
              /* 收起判定的测量镜像:与正文同宽(inset-x-4 对应 px-4)、同字号
                 同换行规则的纯文本。max-h-0 + overflow-hidden 让它不占布局、
                 不产生幽灵滚动区,但 scrollHeight 仍是完整排版高度。 */
              <div
                ref={collapseMirrorRef}
                aria-hidden="true"
                className={cn(
                  'invisible absolute inset-x-4 top-0 max-h-0 overflow-hidden',
                  'whitespace-pre-wrap [overflow-wrap:anywhere]',
                )}
              >
                {bubbleBody}
              </div>
            )}
            <div
              className={cn(
                'whitespace-pre-wrap [overflow-wrap:anywhere]',
                longMessageCollapsed && (automationOrigin ? 'line-clamp-3' : 'line-clamp-10'),
              )}
            >
              {longMessageCollapsed
                // Collapsed chips render as plain text on purpose: otherwise
                // clipped links/file chips can remain focusable behind the
                // visual clamp. Expanding restores the rich chip rendering.
                ? bubbleBody
                : renderContent(
                    bubbleBody,
                    workingDir,
                    async (abs, name, btn) => {
                      if (!(await shouldOpenTextLightboxForOrigin(sessionFileCtx, abs))) return;
                      // F2 / F6: stash the clicked button so the lightbox can
                      // return focus on close. State + ref are shared with the
                      // Chip-Row above ("most recent trigger wins" semantics).
                      activeFileChipRef.current = btn;
                      setTextLightboxFile({ path: abs, name });
                    },
                    (xdtFileUrl) => setLightboxSrc(xdtFileUrl),
                    t,
                    isRemoteFileOrigin(sessionFileCtx.origin),
                  )}
            </div>
            {shouldCollapseLongMessage && (
              <button
                type="button"
                aria-expanded={longMessageExpanded}
                onClick={() => setLongMessageExpanded((expanded) => !expanded)}
                className={cn(
                  'mt-2 inline-flex items-center gap-1 rounded-full px-1 py-0.5',
                  'text-[12px] font-medium leading-5',
                  'text-[var(--msg-user-text)] opacity-65 transition-opacity',
                  'hover:opacity-100',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
                )}
              >
                {longMessageExpanded
                  ? t('chat.userMessage.collapseLongMessage')
                  : t('chat.userMessage.expandLongMessage')}
                {longMessageExpanded ? (
                  <ChevronUp size={13} className="shrink-0" />
                ) : (
                  <ChevronDown size={13} className="shrink-0" />
                )}
              </button>
            )}
          </div>
        )}
        {/* ghost-summon-card:硬指令 / 软提示被兑现 / 语义自主召唤都走合并
            形态(卡片即消息,prompt 富渲染后收进卡身,附件/引用仍在上方
            各自的区块);未兑现的软提示保持低调胶囊。机器追加段的原文收进
            卡片展开区(semantic 无追加段,展开区为来由说明)。running =
            本条消息触发的 turn 仍在执行(最后一条 user 消息 + 会话流式中),
            期间印记环旋转作 loading,turn 结束自动停。 */}
        {ghostCardDisplay && (
          <GhostSummonCard
            directive={ghostCardDisplay}
            running={Boolean(sessionRunning) && Boolean(isLastUserMessage)}
            {...(messageClientId ? { messageClientId } : {})}
            prompt={
              ghostCardPromptBody
                ? renderContent(
                    ghostCardPromptBody,
                    workingDir,
                    async (abs, name, btn) => {
                      if (!(await shouldOpenTextLightboxForOrigin(sessionFileCtx, abs))) return;
                      activeFileChipRef.current = btn;
                      setTextLightboxFile({ path: abs, name });
                    },
                    (xdtFileUrl) => setLightboxSrc(xdtFileUrl),
                    t,
                    isRemoteFileOrigin(sessionFileCtx.origin),
                  )
                : undefined
            }
          />
        )}
        {/* 订阅槽①:被意识钩子拦下 —— 气泡照常显示(未发出),下方渲一条
            error 红条,内容 = 意识返回的文本(直接显示,主机不加框不署名);
            用户用下方的编辑铅笔改了重发(普通重发,不 rewind)。 */}
        {blockedByGhost && (
          <div className="mt-1.5">
            <ErrorMessageCard message={blockedByGhost.reason || t('chat.ghostHook.blockedFallback')} />
          </div>
        )}
        {/* message-actions V1.2: hover-revealed bar below the bubble,
            right-aligned, order [time][copy][edit][undo][fork]。被拦消息只保留
            编辑(改了重发),fork/rewind 对未发消息无意义。 */}
        <MessageActionBar
          createdAt={createdAt}
          copyText={copyText}
          copyLinkText={
            sessionId && messageClientId
              ? buildSessionMessageDeepLink(sessionId, messageClientId)
              : undefined
          }
          align="right"
          hovered={hovered}
          onFork={!isBlocked && canFork ? handleFork : undefined}
          onEdit={canEdit ? handleEdit : undefined}
          onRewind={!isBlocked && canRewind ? handleRewind : undefined}
          rewindInFlight={rewindOpen}
        />
          </>
        )}
          </>
        )}
      </div>
      {/* F5.7: Image Lightbox for user message images */}
      {lightboxSrc && (
        <ImageLightbox
          src={rewriteToRemoteMediaOrigin(lightboxSrc, remoteMediaOrigin)}
          onClose={() => setLightboxSrc(null)}
        />
      )}
      {/* text-lightbox F1: Text Lightbox for file chip click */}
      {textLightboxFile && (
        <TextLightbox
          filePath={textLightboxFile.path}
          fileName={textLightboxFile.name}
          triggerRef={activeFileChipRef}
          onClose={() => setTextLightboxFile(null)}
        />
      )}
      {/* rewind-session: Preview Dialog. Only mounted while open so dryRun
          re-runs cleanly each time (key on clientId for safety). */}
      {rewindOpen && sessionId && messageClientId && (
        <RewindPreviewDialog
          key={messageClientId}
          open={rewindOpen}
          onOpenChange={setRewindOpen}
          sessionId={sessionId}
          clientId={messageClientId}
          onCommitted={handleRewindCommitted}
        />
      )}
    </div>
  );
}
