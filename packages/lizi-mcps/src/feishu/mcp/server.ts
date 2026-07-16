/**
 * feishuMcpServer.ts
 * ---------------------------------------------------------------------------
 * MCP server factory for feishu.
 *
 * 由 maker-core 的 agent (Claude / Codex) 通过 `mcpServers` 字段 in-process 加载。
 * MUST stay free of Electron-only imports (`electron`, `app.*`, `BrowserWindow`, etc.)
 * 以便未来若需要在子进程跑 (例如 stdio host) 同一模块仍能加载。
 *
 * ---------------------------------------------------------------------------
 * Creates an in-process MCP server that exposes Feishu tools to the Claude
 * Agent SDK via `mcpServers` injection.
 *
 * Architecture (progressive discovery):
 *   The 20 fine-grained Feishu tools are NOT registered directly on the MCP
 *   server. Instead they are registered on a FeishuToolRegistry. The MCP
 *   server only exposes two entry tools:
 *
 *     - list_tools(category?)  → discover what's available
 *     - call_tool(name, args)  → invoke a specific tool
 *
 *   This keeps startup context cost to ~400 tokens (vs ~5-8K with full
 *   registration) while preserving zod schema validation and structured
 *   error feedback. See feishuToolRegistry.ts for the registry implementation.
 *
 * All Feishu API calls go through the official @larksuiteoapi/node-sdk.
 * The legacy `/suite/docs-api/search/object` endpoint (not covered by the
 * SDK) is called via `client.request()`.
 *
 * Each SDK session receives its own McpServer instance (created via
 * `createFeishuMcpServer(deps)`). Token/client/cache behavior is supplied by
 * the host through FeishuMcpDeps.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as lark from '@larksuiteoapi/node-sdk';
import { z } from 'zod';
import { jsonObjectArg } from '../../json-object-arg.js';
import { FeishuToolRegistry } from './toolRegistry.js';
import { registerGeneratedTools, projectToCategory } from './genTools.js';
import {
  extractImagesWithSection,
  extractEmbeddedBlocks,
  extractFoldedSections,
  extractMentionedDocs,
  extractMentionedUserIds,
  extractTodos,
  extractStrikethroughs,
  buildDisplayHints,
  splitCompositeToken,
  applyCanonicalUrl,
  type EmbeddedBlockEntry,
  type MentionedDocEntry,
} from './blockManifest.js';
import { parseFeishuTimestampSeconds } from './time.js';
import type { FeishuApiResult, FeishuMcpDeps } from '../../types.js';
import { resolvePathInsideRoot, PathBoundaryError } from '../../shared/assertInsidePath.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Prompts: shared rule docs + per-tool descriptions ──────────────────────
//
// All prompt content lives under `prompts/{rules,tools}/*.md`. Auto-loaded by
// `prompts/index.ts` via `import.meta.glob` — drop a new file in and it shows
// up here keyed by basename. Code only orchestrates; no prompt text inline.
//
// `list_tools` bundles each shared rule body ONCE per category response
// instead of inlining it into every tool's description.

import { TOOL_DESCRIPTIONS as D, RULES } from './prompts/index.js';
import {
  buildNotesQuery,
  classifyMeetingContentStatus,
  DOCX_SEARCH_TYPE,
  isSelfOrganizerHeuristic,
  nameMatches,
  parseMinutesTokenFromUrl,
  parseTargetDate,
  parseVcMeetingTime,
  pickDayMeetingInstances,
  pickMatchingNotes,
  type DayMeetingInstance,
  type MeetingContentStatus,
  type NotesCandidate,
  type RawCalendarInstance,
  type TargetDate,
  type VcMeetingRecord,
} from './meetingNotes.js';
import { FEISHU_DOC_LINK_BASE, FEISHU_MINUTES_LINK_BASE } from '../docLinks.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatToolResult(result: FeishuApiResult) {
  if (result.ok) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, data: result.data }),
        },
      ],
    };
  }
  // AUTH_EXPIRED 是飞书鉴权失效的统一码(本地无 refresh_token,或 refresh_token
  // 被飞书拒绝后重试仍失败)。这种失效只能由用户重新授权解决,所以在返回里直接附上
  // 明确的操作指引,让 agent 如实转述给用户,而不是只丢一个错误码让模型自由发挥。
  const authGuidance =
    result.errorCode === 'AUTH_EXPIRED'
      ? {
          message:
            '飞书登录已失效,当前无法访问任何飞书数据。请告诉用户:点击左下角『设置』→『通用』→ 退出登录,然后重新登录以重新授权飞书。在用户完成重新授权之前,所有飞书操作都会继续失败,请不要重试。',
        }
      : {};
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          errorCode: result.errorCode,
          data: result.data,
          ...authGuidance,
        }),
      },
    ],
    isError: true,
  };
}

function formatInvalidTimeResult(field: string, value: string, reason: string) {
  return formatToolResult({
    ok: false,
    errorCode: 'INVALID_TIME',
    data: {
      field,
      value,
      reason,
      hint: 'Use Unix timestamp seconds, Unix timestamp milliseconds, or RFC3339/ISO time. Date-times without timezone are interpreted in time_zone when provided, otherwise in the host local timezone.',
    },
  });
}

/**
 * Attach `document_url` to a successful docx-write result so the model can
 * reply to the user with a clickable link without having to reconstruct it.
 * No-op on failure or when documentId is missing.
 */
function attachDocumentUrl(result: FeishuApiResult, documentId: string): FeishuApiResult {
  if (!result.ok || !documentId) return result;
  const existing = (result.data as Record<string, unknown> | undefined) ?? {};
  return {
    ...result,
    data: {
      ...existing,
      document_url: `${FEISHU_DOC_LINK_BASE}/docx/${documentId}`,
    },
  };
}

/** Max content size (bytes) before truncation. */
const MAX_CONTENT_BYTES = 100 * 1024; // 100 KB

/** Truncate a string to MAX_CONTENT_BYTES and append a marker. */
function truncateContent(text: string): string {
  if (Buffer.byteLength(text, 'utf-8') <= MAX_CONTENT_BYTES) return text;
  // Binary-search is overkill; just slice by char and recheck.
  let end = text.length;
  while (Buffer.byteLength(text.slice(0, end), 'utf-8') > MAX_CONTENT_BYTES) {
    end = Math.floor(end * 0.9);
  }
  return text.slice(0, end) + '\n[Content truncated]';
}

/** Standard `page_size` + `page_token` zod input shared by every list tool. */
function paginationInput(defaultSize: number) {
  return {
    page_size: z
      .number()
      .default(defaultSize)
      .describe(`每页数量,默认 ${defaultSize} / Page size, default ${defaultSize}`),
    page_token: z
      .string()
      .optional()
      .describe('翻页 token / Pagination token from previous response'),
  };
}

/**
 * Shape a paginated list response for a tool's payload.
 * `itemsKey` is what the tool wants to call its items collection (e.g.
 * 'chats', 'messages', 'records'). Adds has_more/page_token/hint when there
 * are more pages.
 */
function shapePage<T>(
  data: { items?: T[]; has_more?: boolean; page_token?: string } | undefined,
  itemsKey: string,
  hint?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    [itemsKey]: data?.items ?? [],
  };
  if (data?.has_more) {
    payload.has_more = true;
    payload.page_token = data.page_token;
    payload.hint =
      hint ?? `More ${itemsKey} available. Pass the page_token to paginate.`;
  }
  return payload;
}

// ── Factory closure ────────────────────────────────────────────────────────
//
// Everything from here down lives inside `createFeishuMcpServer(deps)` so that
// each server instance has its own captured `deps` reference. No module-level
// globals, no AsyncLocalStorage — name resolution alone routes nested helpers
// (`safeCall`, `withAuthRetry`, `register*Tool`, …) to the correct deps.

export function createFeishuMcpServer(deps: FeishuMcpDeps): McpServer {
  return createFeishuMcpServerWithRegistry(deps).server;
}

/**
 * 同 createFeishuMcpServer,但把内部的 FeishuToolRegistry 一并返回,供
 * 非 MCP 的宿主内直调方(如 scheduler script broker)绕过 transport 直接
 * registry.call(name, args)——工具实现与 zod 校验两条路径完全同源。
 */
export function createFeishuMcpServerWithRegistry(deps: FeishuMcpDeps): {
  server: McpServer;
  registry: FeishuToolRegistry;
} {
  function getFeishuClient(): lark.Client {
    return deps.getFeishuClient();
  }
  function safeCall<T extends { code?: number; msg?: string; data?: unknown }>(
    fn: () => Promise<T>,
  ): Promise<FeishuApiResult> {
    return deps.safeCall(fn);
  }
  function ensureToken(): Promise<{ token: string } | { error: 'AUTH_EXPIRED' }> {
    return deps.ensureToken();
  }
  function forceRefresh(): Promise<{ token: string } | { error: 'AUTH_EXPIRED' }> {
    return deps.forceRefresh();
  }
  const log = {
    debug: (...args: unknown[]) => deps.logger?.debug?.(...args),
    info: (...args: unknown[]) => deps.logger?.info(...args),
    warn: (...args: unknown[]) => deps.logger?.warn(...args),
    error: (...args: unknown[]) => deps.logger?.error(...args),
  };

  /**
   * Resolve an LLM-supplied upload `file_path` to an absolute path constrained
   * to the current session workingDir. Reading arbitrary local files and
   * uploading them to Feishu is a prompt-injection exfil path, so this is
   * fail-closed: no workingDir (or an out-of-bounds / symlink-escaping path)
   * → rejected with PATH_NOT_ALLOWED and the file is never read.
   */
  async function resolveUploadAbsPath(
    filePath: string,
  ): Promise<{ ok: true; absPath: string } | { ok: false; result: FeishuApiResult }> {
    const workingDir = deps.getSessionContext?.().workingDir ?? '';
    if (!workingDir || workingDir.trim().length === 0) {
      return {
        ok: false,
        result: {
          ok: false,
          errorCode: 'PATH_NOT_ALLOWED',
          data: {
            file_path: filePath,
            message:
              '当前会话无 workingDir,出于安全禁止上传本地文件。请把文件放到会话工作目录内再试。',
          },
        },
      };
    }
    try {
      const absPath = await resolvePathInsideRoot(workingDir, filePath);
      return { ok: true, absPath };
    } catch (e) {
      if (e instanceof PathBoundaryError) {
        return {
          ok: false,
          result: {
            ok: false,
            errorCode: 'PATH_NOT_ALLOWED',
            data: { file_path: filePath, message: e.message },
          },
        };
      }
      throw e;
    }
  }

// ── Token helper ────────────────────────────────────────────────────────────

/**
 * Obtain a valid user_access_token wrapped as an SDK request options object.
 * Returns null + an error FeishuApiResult if token acquisition fails.
 */
async function getTokenOptions(): Promise<
  | { options: ReturnType<typeof lark.withUserAccessToken>; error: null }
  | { options: null; error: FeishuApiResult }
> {
  const tokenResult = await ensureToken();
  if ('error' in tokenResult) {
    return { options: null, error: { ok: false, errorCode: 'AUTH_EXPIRED' } };
  }
  return {
    options: lark.withUserAccessToken(tokenResult.token),
    error: null,
  };
}

/**
 * Execute a Feishu API call with automatic retry on AUTH_EXPIRED.
 *
 * 1. Acquire token via ensureToken() (fast-path cache).
 * 2. Run the caller-provided `fn` with that token.
 * 3. If the result is AUTH_EXPIRED, force-refresh the token and retry once.
 */
async function withAuthRetry(
  fn: (opts: ReturnType<typeof lark.withUserAccessToken>) => Promise<FeishuApiResult>,
): Promise<FeishuApiResult> {
  const callId = Math.random().toString(36).slice(2, 8);
  const tok = await getTokenOptions();
  if (tok.error) {
    log.warn(
      `[feishuMcpServer] withAuthRetry call=${callId} ABORT: ensureToken returned error`,
    );
    return tok.error;
  }

  const result = await fn(tok.options);
  if (result.ok) {
    return result;
  }
  if (result.errorCode !== 'AUTH_EXPIRED') {
    // Surface the raw Feishu code/msg if attached, so we can spot codes we
    // failed to map to AUTH_EXPIRED in toResult().
    const detail = result.data as { code?: number; msg?: string } | undefined;
    log.warn(
      `[feishuMcpServer] withAuthRetry call=${callId} attempt=1 NON-AUTH ERROR errorCode=${result.errorCode} feishuCode=${detail?.code ?? '<none>'} feishuMsg=${detail?.msg ?? '<none>'}`,
    );
    return result;
  }

  // Token was rejected by Feishu — force refresh and retry once
  log.warn(
    `[feishuMcpServer] withAuthRetry call=${callId} attempt=1 AUTH_EXPIRED → forceRefresh`,
  );
  const refreshed = await forceRefresh();
  if ('error' in refreshed) {
    log.error(
      `[feishuMcpServer] withAuthRetry call=${callId} forceRefresh FAILED → returning AUTH_EXPIRED to caller`,
    );
    return { ok: false, errorCode: 'AUTH_EXPIRED' };
  }

  const retryResult = await fn(lark.withUserAccessToken(refreshed.token));
  if (!retryResult.ok) {
    const detail = retryResult.data as { code?: number; msg?: string } | undefined;
    log.error(
      `[feishuMcpServer] withAuthRetry call=${callId} attempt=2 STILL FAILED errorCode=${retryResult.errorCode} feishuCode=${detail?.code ?? '<none>'} feishuMsg=${detail?.msg ?? '<none>'}`,
    );
  }
  return retryResult;
}

/**
 * Most handlers do the same 3-line dance: get a client, run one SDK method,
 * wrap the response with safeCall, retry on auth expiry. `callFeishu` collapses
 * all of that — pass a function that takes (client, opts) and calls the SDK.
 *
 * Use the longer `withAuthRetry((opts) => safeCall(...))` form when the closure
 * needs to call multiple SDK methods, paginate, or wrap a non-standard return
 * shape into the `{code, msg, data}` envelope manually.
 */
function callFeishu<T extends { code?: number; msg?: string; data?: unknown }>(
  fn: (
    client: lark.Client,
    opts: ReturnType<typeof lark.withUserAccessToken>,
  ) => Promise<T>,
): Promise<FeishuApiResult> {
  return withAuthRetry((opts) => safeCall(() => fn(getFeishuClient(), opts)));
}

function callOpenApi(
  method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload: { params?: Record<string, unknown>; data?: unknown } = {},
): Promise<FeishuApiResult> {
  return withAuthRetry((opts) => {
    const client = getFeishuClient();
    return safeCall(async () => {
      const res = await client.request<{ code: number; msg?: string; data?: unknown }>(
        { method, url, ...payload },
        opts,
      );
      return res;
    });
  });
}

function resolveP2pChatId(openId: string): Promise<FeishuApiResult> {
  return withAuthRetry((opts) =>
    deps.resolveP2pChatId(getFeishuClient(), openId, opts),
  );
}

function callSheetV2(
  method: 'GET' | 'PUT' | 'POST',
  url: string,
  payload: { params?: Record<string, unknown>; data?: unknown } = {},
): Promise<FeishuApiResult> {
  return callOpenApi(method, url, payload);
}

/**
 * Drain a Feishu list endpoint that uses `page_token`/`has_more` pagination
 * into a single `{ items: [...] }` result. The fetcher receives the cursor
 * (undefined on the first call) and returns one page wrapped as a
 * FeishuApiResult. Aborts and returns the raw error on the first failed page.
 */
async function paginateAll<T = unknown>(
  fetchPage: (cursor: string | undefined) => Promise<FeishuApiResult>,
): Promise<FeishuApiResult> {
  const all: T[] = [];
  let cursor: string | undefined;
  while (true) {
    const r = await fetchPage(cursor);
    if (!r.ok) return r;
    const data = r.data as
      | { items?: T[]; has_more?: boolean; page_token?: string }
      | undefined;
    if (data?.items) all.push(...data.items);
    if (data?.has_more && data.page_token) {
      cursor = data.page_token;
    } else {
      return { ok: true, data: { items: all } };
    }
  }
}

// ── Shared readers (used by fine-grained tools AND the aggregate tool) ──────

/**
 * Read bitable table list for an app.
 */
async function readBitableTables(appToken: string): Promise<FeishuApiResult> {
  return callFeishu((c, opts) =>
    c.bitable.appTable.list({ path: { app_token: appToken } }, opts),
  );
}

// ── Feishu docs search helper ───────────────────────────────────────────────

interface SearchResultItem {
  title?: string;
  url?: string;
  docs_token?: string;
  docs_type?: number;
  owner?: { name?: string };
  last_modified_time?: string;
  [key: string]: unknown;
}

type WikiObjType = 'doc' | 'sheet' | 'mindnote' | 'bitable' | 'file' | 'docx' | 'slides';

interface WikiNodeItem {
  space_id?: string;
  node_token?: string;
  obj_token?: string;
  obj_type?: WikiObjType;
  parent_node_token?: string;
  node_type?: 'origin' | 'shortcut';
  origin_node_token?: string;
  origin_space_id?: string;
  has_child?: boolean;
  title?: string;
  obj_create_time?: string;
  obj_edit_time?: string;
  node_create_time?: string;
  creator?: string;
  owner?: string;
  node_creator?: string;
}

interface DriveMetaItem {
  doc_token: string;
  doc_type: string;
  title: string;
  owner_id: string;
  create_time: string;
  latest_modify_user: string;
  latest_modify_time: string;
  url: string;
  sec_label_name?: string;
}

interface DriveMetaBatchResult {
  metaMap: Map<string, DriveMetaItem>;
  requested: number;
  failed: Array<{ token: string; code: number }>;
  errors: string[];
}

/**
 * Search docs via the legacy `/suite/docs-api/search/object` endpoint.
 * This API is not covered by the SDK's typed methods, so we use
 * `client.request()` as an escape hatch.
 */
async function searchDocs(
  query: string,
  docsTypes: number[],
  count: number,
  extraBody?: Record<string, unknown>,
): Promise<FeishuApiResult> {
  return withAuthRetry((opts) => {
    const client = getFeishuClient();
    const body = {
      search_key: query,
      count,
      docs_types: docsTypes,
      ...extraBody,
    };

    return safeCall(async () => {
      const res = await client.request<{
        code: number;
        msg?: string;
        data?: unknown;
      }>(
        {
          method: 'POST',
          url: '/open-apis/suite/docs-api/search/object',
          data: body,
        },
        opts,
      );
      return res;
    });
  });
}

// ── Reusable media fetcher (used by media_download AND readDocWithImageManifest) ───

/**
 * Fetch raw bytes for a single Feishu file_token via drive.media.download.
 * Returns { buffer, mimeType }; throws on auth/network failure (caller handles).
 */
async function fetchMediaBytes(
  fileToken: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const fetchResult = await withAuthRetry(async (opts) => {
    const client = getFeishuClient();
    return safeCall(async () => {
      const res = await client.drive.media.download(
        { path: { file_token: fileToken } },
        opts,
      );
      const buffer = await deps.streamToBuffer(res.getReadableStream());
      const mimeType = deps.mimeFromHeaders(res.headers);
      return { code: 0, data: { buffer, mimeType } };
    });
  });
  if (!fetchResult.ok) {
    throw new Error(`download failed: ${fetchResult.errorCode ?? 'unknown'}`);
  }
  return fetchResult.data as { buffer: Buffer; mimeType: string };
}

// Image manifest extraction lives in ./feishuBlockManifest (pure, testable).

/**
 * Read a docx-style document (docx or wiki-resolved obj_token) returning:
 *   - flattened text (rawContent API)
 *   - up to maxImages downloaded inline (xdt_image_urls + image content blocks)
 *
 * Network: rawContent + documentBlock.list run concurrently;
 * image downloads run in parallel with built-in cache + in-flight dedup
 * (via feishuMediaStore.getOrDownload).
 */
/**
 * Fetch all comments (and their replies) for a docx document. Paginates
 * through `drive.fileComment.list`. Best-effort: returns an empty array if
 * the API call fails so doc reading isn't blocked by comment-permission gaps.
 *
 * Each returned comment carries the original open_ids (commenter / repliers /
 * solver) — name resolution happens later in readDocWithImageManifest so it
 * can be batched with the same call that resolves any other open_ids.
 */
type DocReply = {
  reply_id?: string;
  user_id?: string;
  user_name?: string;
  text: string;
  create_time?: number;
};
type DocComment = {
  comment_id?: string;
  user_id?: string;
  user_name?: string;
  create_time?: number;
  is_solved?: boolean;
  solver_user_id?: string;
  solver_user_name?: string;
  is_whole?: boolean;
  quote?: string;
  replies: DocReply[];
};

function flattenReplyContent(
  elements: Array<{
    type: string;
    text_run?: { text: string };
    docs_link?: { url: string };
    person?: { user_id: string };
  }> | undefined,
): { text: string; mentioned_user_ids: string[] } {
  const parts: string[] = [];
  const mentioned: string[] = [];
  for (const el of elements ?? []) {
    if (el.type === 'text_run' && el.text_run?.text) {
      parts.push(el.text_run.text);
    } else if (el.type === 'docs_link' && el.docs_link?.url) {
      parts.push(el.docs_link.url);
    } else if (el.type === 'person' && el.person?.user_id) {
      // Substitute later once names are resolved
      parts.push(`@${el.person.user_id}`);
      mentioned.push(el.person.user_id);
    }
  }
  return { text: parts.join(''), mentioned_user_ids: mentioned };
}

async function fetchDocComments(
  documentId: string,
): Promise<{ comments: DocComment[]; allUserIds: Set<string> }> {
  const result = await paginateAll((cursor) =>
    callFeishu((c, opts) =>
      c.drive.fileComment.list(
        {
          params: {
            file_type: 'docx',
            page_size: 100,
            user_id_type: 'open_id',
            ...(cursor ? { page_token: cursor } : {}),
          },
          path: { file_token: documentId },
        },
        opts,
      ),
    ),
  );

  if (!result.ok) {
    log.warn(
      `fetchDocComments failed for ${documentId}: ${result.errorCode} — proceeding with empty comments`,
    );
    return { comments: [], allUserIds: new Set() };
  }

  type RawComment = {
    comment_id?: string;
    user_id?: string;
    create_time?: number;
    is_solved?: boolean;
    solver_user_id?: string;
    is_whole?: boolean;
    quote?: string;
    reply_list?: {
      replies?: Array<{
        reply_id?: string;
        user_id?: string;
        create_time?: number;
        content?: { elements?: Parameters<typeof flattenReplyContent>[0] };
      }>;
    };
  };

  const items = ((result.data as { items?: RawComment[] } | undefined)?.items ?? []);
  const comments: DocComment[] = [];
  const allUserIds = new Set<string>();

  for (const c of items) {
    if (c.user_id) allUserIds.add(c.user_id);
    if (c.solver_user_id) allUserIds.add(c.solver_user_id);

    const replies: DocReply[] = (c.reply_list?.replies ?? []).map((r) => {
      const flat = flattenReplyContent(r.content?.elements);
      flat.mentioned_user_ids.forEach((id) => allUserIds.add(id));
      if (r.user_id) allUserIds.add(r.user_id);
      return {
        reply_id: r.reply_id,
        user_id: r.user_id,
        text: flat.text,
        create_time: r.create_time,
      };
    });

    comments.push({
      comment_id: c.comment_id,
      user_id: c.user_id,
      create_time: c.create_time,
      is_solved: c.is_solved,
      solver_user_id: c.solver_user_id,
      is_whole: c.is_whole,
      quote: c.quote,
      replies,
    });
  }

  return { comments, allUserIds };
}

/**
 * Convert a 1-based column index into A1 column letters.
 * 1 -> A, 26 -> Z, 27 -> AA, 702 -> ZZ, 703 -> AAA.
 */
function columnIndexToLetter(index: number): string {
  let result = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

interface FirstSheetMeta {
  sheet_id: string;
  title?: string;
  index?: number;
  hidden?: boolean;
  resource_type?: string;
  grid_properties?: {
    row_count?: number;
    column_count?: number;
  };
}

interface SheetV2BlockMeta {
  properties?: {
    sheetId?: string;
    sheet_id?: string;
    blockInfo?: {
      blockToken?: string;
      blockType?: string;
      block_token?: string;
      block_type?: string;
    };
  };
  sheetId?: string;
  sheet_id?: string;
  blockInfo?: {
    blockToken?: string;
    blockType?: string;
    block_token?: string;
    block_type?: string;
  };
}

interface EmbeddedBitableRef {
  app_token: string;
  table_id: string;
  block_type?: string;
}

/**
 * Read legacy v2 sheet metadata. Feishu exposes the composite
 * `{app_token}_{table_id}` block token for embedded bitable tabs only through
 * this endpoint; the v3 sheet query reports `resource_type=bitable` without
 * the identifiers needed by the bitable API.
 */
async function getSheetV2BlockMeta(spreadsheetToken: string): Promise<FeishuApiResult> {
  const result = await callOpenApi(
    'GET',
    `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/metainfo`,
  );
  if (!result.ok) return result;
  const sheets =
    (result.data as { sheets?: SheetV2BlockMeta[] } | undefined)?.sheets ?? [];
  return { ok: true, data: sheets };
}

function parseEmbeddedBitableRef(
  sheet: SheetV2BlockMeta,
  tableHint?: string,
): EmbeddedBitableRef | null {
  const blockInfo = sheet.blockInfo ?? sheet.properties?.blockInfo;
  const blockToken = blockInfo?.blockToken ?? blockInfo?.block_token;
  if (!blockToken) return null;
  const { main_token: appToken, sub_id: blockTableId } = splitCompositeToken(blockToken);
  const tableId = tableHint ?? blockTableId;
  if (!appToken || !tableId || !tableId.startsWith('tbl')) return null;
  return {
    app_token: appToken,
    table_id: tableId,
    ...(blockInfo?.blockType || blockInfo?.block_type
      ? { block_type: blockInfo.blockType ?? blockInfo.block_type }
      : {}),
  };
}

async function resolveEmbeddedBitableRef(
  spreadsheetToken: string,
  sheetId: string,
  tableHint?: string,
): Promise<FeishuApiResult> {
  const result = await getSheetV2BlockMeta(spreadsheetToken);
  if (!result.ok) return result;
  const sheets = result.data as SheetV2BlockMeta[];
  const target = sheets.find(
    (sheet) =>
      (sheet.sheetId ?? sheet.sheet_id ?? sheet.properties?.sheetId ?? sheet.properties?.sheet_id) ===
      sheetId,
  );
  const ref = target ? parseEmbeddedBitableRef(target, tableHint) : null;
  if (!ref) {
    return {
      ok: false,
      errorCode: 'NOT_FOUND',
      data: {
        spreadsheet_token: spreadsheetToken,
        sheet_id: sheetId,
        hint: 'v2 metainfo 未返回可用的内嵌多维表格 blockToken',
      },
    };
  }
  return { ok: true, data: ref };
}

/**
 * Fetch metadata for every sheet/tab in a spreadsheet via the v3 sheets query
 * endpoint. Returns the raw `sheets[]` array (each with sheet_id / title /
 * index / hidden / grid_properties / resource_type) on success. This is the
 * single source of truth for both the `sheet_list_sheets` tool and the read
 * path's tab resolution.
 */
async function getAllSheetsMeta(spreadsheetToken: string): Promise<FeishuApiResult> {
  const result = await callFeishu((c, opts) =>
    c.sheets.spreadsheetSheet.query(
      { path: { spreadsheet_token: spreadsheetToken } },
      opts,
    ),
  );
  if (!result.ok) return result;
  const sheets =
    (result.data as { sheets?: FirstSheetMeta[] } | undefined)?.sheets ?? [];
  return { ok: true, data: sheets };
}

/**
 * Resolve which tab a read should target. With no selector, returns the first
 * sheet (legacy behaviour, used when the caller doesn't care about tabs). With
 * a selector, matches by exact `sheet_id` first, then by exact `title`; on a
 * miss returns NOT_FOUND together with the list of available tabs so the agent
 * can self-correct instead of silently falling back to the first tab (the old
 * bug where later tabs of a multi-tab spreadsheet were unreachable).
 */
async function resolveTargetSheet(
  spreadsheetToken: string,
  selector?: string,
): Promise<FeishuApiResult> {
  const allResult = await getAllSheetsMeta(spreadsheetToken);
  if (!allResult.ok) return allResult;
  const sheets = allResult.data as FirstSheetMeta[];
  if (!selector) {
    const firstSheet = sheets.find((sheet) => sheet.sheet_id);
    if (!firstSheet?.sheet_id) {
      return { ok: false, errorCode: 'NOT_FOUND', data: { hint: '电子表格下没有可读取的 sheet 页签' } };
    }
    return { ok: true, data: firstSheet };
  }
  const match =
    sheets.find((sheet) => sheet.sheet_id === selector) ??
    sheets.find((sheet) => sheet.title === selector);
  if (!match?.sheet_id) {
    return {
      ok: false,
      errorCode: 'NOT_FOUND',
      data: {
        hint: '找不到指定页签;sheet 参数需传 sheet_id 或页签标题(title),可先用 sheet_list_sheets 列出全部页签',
        requested: selector,
        available_sheets: sheets.map((sheet) => ({ sheet_id: sheet.sheet_id, title: sheet.title })),
      },
    };
  }
  return { ok: true, data: match };
}

async function readSheetRange(
  spreadsheetToken: string,
  range?: string,
  sheetSelector?: string,
  tableHint?: string,
  viewHint?: string,
  urlSheetId?: string,
): Promise<FeishuApiResult> {
  // Split an explicit "<sheetId>!" prefix off the range so the target tab is
  // always resolved below — the bitable type check must run even for fully
  // prefixed ranges, otherwise an embedded bitable tab like "2cjT0b!A1:D20"
  // falls through to the values endpoint and surfaces an opaque Feishu error
  // instead of the INVALID_ARGS contract. The prefix wins over `sheetSelector`
  // when both are present (it is the more specific instruction).
  let rangeBody = range;
  let rangePrefix: string | undefined;
  if (range) {
    // Split on the LAST '!': the A1 range body never contains one, while a
    // quoted tab name may ("'Data!2024'!A1:B2").
    const separatorIndex = range.lastIndexOf('!');
    if (separatorIndex >= 0) {
      // A1 notation quotes tab names containing spaces etc. ("'My Tab'!A1:B2",
      // a literal quote escaped as ''); strip the quoting so the prefix
      // matches the real tab title in resolveTargetSheet.
      const rawRangePrefix = range.slice(0, separatorIndex);
      rangePrefix =
        rawRangePrefix.length >= 2 &&
        rawRangePrefix.startsWith("'") &&
        rawRangePrefix.endsWith("'")
          ? rawRangePrefix.slice(1, -1).replace(/''/g, "'") || undefined
          : rawRangePrefix || undefined;
      rangeBody = range.slice(separatorIndex + 1);
    }
  }
  // Resolve the target tab either to prefix the user's range or to build a
  // precise default range from the tab's actual grid dimensions (avoids the
  // old A1:ZZ5000 default that always tripped the 10MB API cap). `sheetSelector`
  // lets callers reach tabs other than the first one; without it we keep the
  // legacy "first tab" behaviour.
  const targetSheetResult = await resolveTargetSheet(
    spreadsheetToken,
    rangePrefix ?? sheetSelector,
  );
  if (!targetSheetResult.ok) return targetSheetResult;
  const targetSheet = targetSheetResult.data as FirstSheetMeta;
  const sheetTitle = targetSheet.title;
  if (targetSheet.resource_type === 'bitable') {
    if (range) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        data: {
          range,
          hint: '多维表格页签按记录读取,请省略 A1 range',
        },
      };
    }
    // The URL's table/view hints belong to the tab its `?sheet=` points at;
    // apply them only when the resolved target IS that tab. Comparing by
    // resolved sheet_id (not the caller's raw selector string) keeps them for
    // callers that name the same tab by title. Without a URL tab id the hints'
    // owner is unknown, so only the default no-selector read may use them.
    const applyUrlHints = urlSheetId
      ? targetSheet.sheet_id === urlSheetId
      : !sheetSelector && !rangePrefix;
    const effectiveTableHint = applyUrlHints ? tableHint : undefined;
    const effectiveViewHint = applyUrlHints ? viewHint : undefined;
    const refResult = await resolveEmbeddedBitableRef(
      spreadsheetToken,
      targetSheet.sheet_id,
      effectiveTableHint,
    );
    if (!refResult.ok) return refResult;
    const ref = refResult.data as EmbeddedBitableRef;
    const params: {
      page_size: number;
      view_id?: string;
    } = { page_size: 20 };
    if (effectiveViewHint) params.view_id = effectiveViewHint;
    const recordsResult = await callFeishu((c, opts) =>
      c.bitable.appTableRecord.list(
        {
          path: { app_token: ref.app_token, table_id: ref.table_id },
          params,
        },
        opts,
      ),
    );
    if (!recordsResult.ok) return recordsResult;
    const data = recordsResult.data as {
      items?: unknown[];
      has_more?: boolean;
      page_token?: string;
      total?: number;
    } | undefined;
    return {
      ok: true,
      data: {
        resource_type: 'bitable',
        spreadsheet_token: spreadsheetToken,
        sheet_id: targetSheet.sheet_id,
        ...(sheetTitle ? { sheet_title: sheetTitle } : {}),
        ...ref,
        ...(effectiveViewHint ? { view_id: effectiveViewHint } : {}),
        records: data?.items ?? [],
        total: data?.total,
        ...(data?.has_more
          ? { has_more: true, page_token: data.page_token }
          : { has_more: false }),
      },
    };
  }
  let effectiveRange: string;
  if (rangeBody) {
    effectiveRange = `${targetSheet.sheet_id}!${rangeBody}`;
  } else {
    const rowCount = targetSheet.grid_properties?.row_count ?? 0;
    const columnCount = targetSheet.grid_properties?.column_count ?? 0;
    if (rowCount <= 0 || columnCount <= 0) {
      return {
        ok: true,
        data: {
          spreadsheet_token: spreadsheetToken,
          range: `${targetSheet.sheet_id}!A1:A1`,
          ...(sheetTitle ? { sheet_title: sheetTitle } : {}),
          row_count: 0,
          column_count: 0,
          values: [],
        },
      };
    }
    const lastCol = columnIndexToLetter(columnCount);
    effectiveRange = `${targetSheet.sheet_id}!A1:${lastCol}${rowCount}`;
  }

  const result = await callSheetV2(
    'GET',
    `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(spreadsheetToken)}/values/${encodeURIComponent(effectiveRange)}`,
    { params: { valueRenderOption: 'ToString' } },
  );
  if (!result.ok) return result;

  const valueRange = (result.data as { valueRange?: { range?: string; values?: unknown[][] } } | undefined)?.valueRange;
  const values = Array.isArray(valueRange?.values) ? valueRange.values : [];
  return {
    ok: true,
    data: {
      spreadsheet_token: spreadsheetToken,
      range: valueRange?.range ?? effectiveRange,
      ...(sheetTitle ? { sheet_title: sheetTitle } : {}),
      row_count: values.length,
      column_count: values.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0),
      values,
    },
  };
}

function sheetUrl(spreadsheetToken: string): string {
  return `${FEISHU_DOC_LINK_BASE}/sheets/${spreadsheetToken}`;
}

async function readDocWithImageManifest(
  documentId: string,
  maxImages: number = 0,
  url?: string,
) {
  // 1. Fire text + blocks + comments fetches in parallel.
  //    Comments are best-effort (fetchDocComments swallows errors and returns
  //    an empty list) so a comments permission gap doesn't block the read.
  const [textResult, blocksResult, commentsResult] = await Promise.all([
    callFeishu((c, opts) =>
      c.docx.document.rawContent({ path: { document_id: documentId } }, opts),
    ),
    paginateAll((cursor) =>
      callFeishu((c, opts) =>
        c.docx.documentBlock.list(
          {
            params: {
              page_size: 500,
              ...(cursor ? { page_token: cursor } : {}),
            },
            path: { document_id: documentId },
          },
          opts,
        ),
      ),
    ),
    fetchDocComments(documentId),
  ]);

  if (!textResult.ok) return formatToolResult(textResult);
  if (!blocksResult.ok) return formatToolResult(blocksResult);

  const textData = textResult.data as { content?: string } | undefined;
  const text = textData?.content ?? '';
  const blocks = (blocksResult.data as { items?: unknown[] } | undefined)?.items ?? [];

  // 2. Run all block extractors first (pure, no IO) so we know what
  //    follow-up network calls are needed.
  //
  //    - manifest:        images (per section), download lazily
  //    - embedded:        non-text-flow blocks (sheets, bitables, files…)
  //    - folded:          headings collapsed in feishu UI
  //    - mentionedDocs:   inline mention_doc references in body text
  //    - todos:           todo items with done state
  //    - bodyUserIds:     open_ids referenced via mention_user in body
  const manifest = extractImagesWithSection(blocks);
  const embedded = extractEmbeddedBlocks(blocks);
  const folded = extractFoldedSections(blocks);
  const mentionedDocs = extractMentionedDocs(blocks);
  const todos = extractTodos(blocks);
  // Strikethrough manifest: rawContent strips strikethrough styling, leading
  // the LLM to cite obsolete (struck-out) rules as if they were current.
  // Surfacing them in the display hints + summary lets the agent tell which
  // clauses are deletions vs. live content.
  const strikethroughs = extractStrikethroughs(blocks);
  const bodyMentionedUserIds = extractMentionedUserIds(blocks);

  // 3. Run two independent network calls in parallel:
  //    (a) Resolve all open_ids (comments + body) to display names
  //    (b) Batch-fetch titles for embedded sheet/bitable + mentioned docs
  //    Each is best-effort; failure falls back to placeholders / generic
  //    labels without blocking the main response.
  const allMentionedIds = new Set<string>(commentsResult.allUserIds);
  for (const id of bodyMentionedUserIds) allMentionedIds.add(id);

  const [userMap, { metaMap: embedMetaMap, failedTokens: embedFailedTokens }] =
    await Promise.all([
      resolveOpenIdsToNames(allMentionedIds),
      fetchEmbedAndMentionTitles(embedded, mentionedDocs),
    ]);

  // 4. Patch comments + replies with resolved user names. Mention tokens
  //    inside reply text (`@ou_xxx`) get rewritten to `@<name>` once known.
  for (const c of commentsResult.comments) {
    if (c.user_id && userMap.has(c.user_id)) c.user_name = userMap.get(c.user_id);
    if (c.solver_user_id && userMap.has(c.solver_user_id)) {
      c.solver_user_name = userMap.get(c.solver_user_id);
    }
    for (const r of c.replies) {
      if (r.user_id && userMap.has(r.user_id)) r.user_name = userMap.get(r.user_id);
      // Replace @ou_xxx → @张三(ou_xxx). Keep the open_id visible so the
      // user (typically a 策划) can copy it to DM the person directly
      // without doing a separate contact lookup.
      r.text = r.text.replace(/@ou_[A-Za-z0-9]+/g, (match) => {
        const id = match.slice(1);
        return userMap.has(id) ? `@${userMap.get(id)}(${id})` : match;
      });
    }
  }

  // 5. Patch embedded + mentioned entries with resolved title + canonical
  //    URL in place. Two rules:
  //      - title: only fill if not already present (file blocks set their
  //        own title from file.name during extraction; don't overwrite).
  //      - url:   ALWAYS overwrite with drive.meta's URL when available —
  //        our inferred `https://feishu.cn/...` URLs frequently 404 or
  //        redirect to a login page for non-default tenants. drive.meta
  //        returns the proper tenant-scoped URL that actually opens.
  //    Drive.meta returns are keyed by token alone — since sheets/bitables/
  //    docs have globally unique tokens, type collision isn't a concern.
  for (const e of embedded) {
    if (!e.ref) continue;
    const lookupToken = needsCompositeSplit(e.type_name)
      ? splitCompositeToken(e.ref).main_token
      : e.ref;

    // If drive.meta refused this token under the assumed type (e.g. 画册
    // surfaces in the docx tree as bitable but isn't a real bitable),
    // flag it as uncertain and drop the inferred URL — that URL would
    // 404. Display hints render a ⚠️ + emphasize the token instead.
    if (embedFailedTokens.has(lookupToken)) {
      e.type_uncertain = true;
      e.url = undefined;
      // DEBUG: dump enough info to investigate type-mismatch cases (most
      // commonly 画册-shaped-as-bitable). When the user reports a broken
      // embed, grep desktop logs for 'embed-type-uncertain' to find the
      // raw block_type/ref/section it came from.
      log.debug(
        `embed-type-uncertain: block_type=${e.block_type} type_name=${e.type_name} ref=${e.ref} lookup=${lookupToken} section=${e.section_hint}`,
      );
      continue;
    }

    const meta = embedMetaMap.get(lookupToken);
    if (!meta) continue;
    if (!e.title && meta.title) e.title = meta.title;
    if (meta.url) {
      // For bitable / sheet, drive.meta returns the app/spreadsheet-level
      // URL; layer back the original embed's `?table=...` / `?sheet=...`
      // so the user lands on the right table/tab.
      e.url = applyCanonicalUrl(meta.url, e.block_type, e.ref);
    }
  }
  for (const m of mentionedDocs) {
    const lookupToken = needsCompositeSplit(m.obj_type)
      ? splitCompositeToken(m.token).main_token
      : m.token;
    // For mention_doc we don't drop the URL on drive.meta failure because
    // the element often carries a Feishu-provided inline `url` that's still
    // trustworthy. We only enrich title + canonicalize URL when drive.meta
    // succeeded; otherwise keep whatever extractMentionedDocs already set.
    const meta = embedMetaMap.get(lookupToken);
    if (!meta) continue;
    if (!m.title && meta.title) m.title = meta.title;
    if (meta.url) {
      // Same sub-id preservation for mention_doc → bitable/sheet.
      m.url = needsCompositeSplit(m.obj_type)
        ? applyCanonicalUrl(
            meta.url,
            m.obj_type === 'bitable' ? 18 : 30,
            m.token,
          )
        : meta.url;
    }
  }

  // 3. Download only up to maxImages (in document order).
  //    Failures are captured per-image so partial success is still useful.
  const tokensToDownload = manifest.slice(0, maxImages);
  const skippedCount = Math.max(0, manifest.length - tokensToDownload.length);

  const downloads = await Promise.all(
    tokensToDownload.map(async (entry) => {
      try {
        const mediaResult = await deps.getOrDownloadMedia(entry.file_token, fetchMediaBytes);
        return { entry, ok: true as const, result: mediaResult };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { entry, ok: false as const, error: msg };
      }
    }),
  );

  const successful = downloads.filter((d) => d.ok);
  const failed = downloads.filter((d) => !d.ok);
  const downloadedTokens = new Set(successful.map((d) => d.entry.file_token));

  // 4. Annotate manifest with download status so Claude sees both
  //    "what's available" and "what's already in this turn's context".
  const availableImages = manifest.map((entry) => ({
    ...entry,
    downloaded: downloadedTokens.has(entry.file_token),
  }));

  // 5. Build JSON summary (text content block).
  const hint =
    maxImages === 0
      ? '默认未下载图片;按需调 media_download(file_token),全量重调本工具 max_images=20'
      : skippedCount > 0
        ? `已下载 ${successful.length}/${manifest.length} 张;剩余调 media_download 单拉,或重调本工具调高 max_images`
        : undefined;

  const userMapObj: Record<string, string> = {};
  for (const [k, v] of userMap) userMapObj[k] = v;

  const summary: Record<string, unknown> = {
    ok: true,
    ...(url ? { url } : {}),
    document_id: documentId,
    text: truncateContent(text),
    text_truncated: Buffer.byteLength(text, 'utf-8') > MAX_CONTENT_BYTES,
    image_count: manifest.length,
    available_images: availableImages,
    embedded_count: embedded.length,
    ...(embedded.length > 0 ? { embedded_blocks: embedded } : {}),
    folded_count: folded.length,
    ...(folded.length > 0 ? { folded_sections: folded } : {}),
    mentioned_doc_count: mentionedDocs.length,
    ...(mentionedDocs.length > 0 ? { mentioned_docs: mentionedDocs } : {}),
    todo_count: todos.length,
    ...(todos.length > 0 ? { todos } : {}),
    strikethrough_count: strikethroughs.length,
    ...(strikethroughs.length > 0 ? { strikethroughs } : {}),
    images_downloaded: successful.length,
    images_skipped: skippedCount,
    images_failed: failed.length,
    images: successful.map((d) => ({
      file_token: d.entry.file_token,
      mime: d.result.mimeType,
      bytes: d.result.originalBytes,
      original_path: d.result.originalPath,
      xdt_image_url: d.result.xdtImageUrl,
    })),
    xdt_image_urls: successful
      .map((d) => d.result.xdtImageUrl)
      .filter((u): u is string => typeof u === 'string'),
    // _xdt_render_image: 读文档场景下,文档里嵌入的图通常是上下文截图/示意,
    // 不希望它们在工具调用条目下方刷一长串图片卡片(尤其是 max_images>0 一次拉多张时)。
    // LLM 仍可从 xdt_image_urls 拿 URL,自行决定要不要在最终回复里嵌入。
    // 与 media_download 的策略保持一致 (server.ts 里 _xdt_render_image: false 同款语义)。
    ...(successful.length > 0 ? { _xdt_render_image: false } : {}),
    ...(failed.length > 0
      ? { failed_image_tokens: failed.map((d) => d.entry.file_token) }
      : {}),
    comment_count: commentsResult.comments.length,
    comments: commentsResult.comments,
    ...(Object.keys(userMapObj).length > 0 ? { user_map: userMapObj } : {}),
    ...(hint ? { hint } : {}),
  };

  // 6. Build content blocks: text summary + pre-formatted display hints +
  //    image blocks (vision input for Claude).
  //
  //    The display hints are a second text block containing markdown that's
  //    already shaped exactly how we want the LLM to surface it to the user
  //    (clickable links for embedded objects, one-line note for folded
  //    sections). Empirically the LLM is far more likely to paste a
  //    pre-formatted snippet verbatim than to reconstruct the same content
  //    from JSON — this moves "embed visibility" from prompt-rule territory
  //    (depends on LLM compliance) toward code territory (deterministic).
  type Block =
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string };
  const blocksOut: Block[] = [
    { type: 'text', text: JSON.stringify(summary) },
  ];

  const displayHints = buildDisplayHints(
    embedded,
    folded,
    mentionedDocs,
    todos,
    strikethroughs,
  );
  if (displayHints) {
    blocksOut.push({ type: 'text', text: displayHints });
  }

  for (const d of successful) {
    const inline = d.result.preview ?? d.result.inline;
    if (inline) {
      blocksOut.push({
        type: 'image',
        data: inline.base64,
        mimeType: inline.mimeType,
      });
    }
  }

  return { content: blocksOut };
}

// ── Tool registration (into FeishuToolRegistry, not McpServer) ──────────────

function registerReadByUrlTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'read_by_url',
    category: 'misc',
    description: D.read_by_url,
    rules: ['read'],
    inputShape: {
      url: z
        .string()
        .describe(
          '飞书文档 URL(支持 feishu.cn/wiki/*, /docx/*, /docs/*, /base/*, /sheets/* 格式)',
        ),
      max_images: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(0)
        .describe('最多自动下载几张图,默认 0(只返回 available_images 清单)。需要某张图时调 media_download 单拉,用户要求全看时传 20'),
    },
    handler: async ({ url, max_images }) => {
      // ── Wiki URL ──
      const wikiMatch = url.match(/feishu\.cn\/wiki\/(\w+)/);
      if (wikiMatch) {
        const nodeToken = wikiMatch[1];
        // Resolve wiki node → obj_token
        const nodeResult = await callFeishu((c, opts) =>
          c.wiki.space.getNode({ params: { token: nodeToken } }, opts),
        );
        if (!nodeResult.ok) return formatToolResult(nodeResult);

        const nodeData = (nodeResult.data as { node?: { obj_token?: string; obj_type?: string } } | undefined)?.node;
        const objToken = nodeData?.obj_token;
        const objType = nodeData?.obj_type;
        if (!objToken) {
          return formatToolResult({ ok: false, errorCode: 'NOT_FOUND' });
        }
        // wiki node may resolve to a bitable — fall back to table list.
        if (objType === 'bitable') {
          const result = await readBitableTables(objToken);
          return formatToolResult(result);
        }
        if (objType === 'sheet') {
          return formatToolResult(await readSheetRange(objToken));
        }
        return readDocWithImageManifest(objToken, max_images, url);
      }

      // ── Docx / Docs URL ──
      const docxMatch = url.match(/feishu\.cn\/(?:docx|docs)\/(\w+)/);
      if (docxMatch) {
        return readDocWithImageManifest(docxMatch[1], max_images, url);
      }

      // ── Sheet URL ──
      const sheetMatch = url.match(/feishu\.cn\/sheets\/([A-Za-z0-9]+)/);
      if (sheetMatch) {
        return formatToolResult(await readSheetRange(sheetMatch[1]));
      }

      // ── Bitable (Base) URL ──
      const baseMatch = url.match(/feishu\.cn\/base\/(\w+)/);
      if (baseMatch) {
        const appToken = baseMatch[1];
        // Try to extract `table` query parameter
        let tableId: string | null = null;
        try {
          const parsed = new URL(url);
          tableId = parsed.searchParams.get('table');
        } catch {
          /* ignore malformed URL */
        }

        if (tableId) {
          const result = await callFeishu((c, opts) =>
            c.bitable.appTableRecord.list(
              {
                params: { page_size: 20 },
                path: { app_token: appToken, table_id: tableId },
              },
              opts,
            ),
          );
          return formatToolResult(result);
        }

        // No table param → list all tables (readBitableTables has its own retry)
        const result = await readBitableTables(appToken);
        return formatToolResult(result);
      }

      // ── Unsupported URL format ──
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              errorCode: 'UNSUPPORTED_URL',
              data: { url },
            }),
          },
        ],
        isError: true,
      };
    },
  });
}

// ── Fine-grained tools ─────────────────────────────────────────────────────

// 1. docx_search
function registerDocxSearchTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'docx_search',
    category: 'docx',
    description: D.docx_search,
    inputShape: {
      query: z.string().describe('搜索关键词 / Search keywords'),
      page_size: z
        .number()
        .default(20)
        .describe('返回数量,默认 20 / Number of results, default 20'),
    },
    handler: async ({ query, page_size }) => {
      const result = await searchDocs(query, [22], page_size);
      if (!result.ok) return formatToolResult(result);

      const data = result.data as {
        docs_entities?: SearchResultItem[];
        has_more?: boolean;
      } | undefined;
      const items = (data?.docs_entities ?? []).map((d) => ({
        title: d.title,
        url: d.url,
        doc_token: d.docs_token,
        owner: d.owner?.name,
        last_modified: d.last_modified_time,
      }));

      const payload: Record<string, unknown> = { docs: items };
      if (data?.has_more) {
        payload.hint = 'More results available. Narrow your query or increase page_size.';
      }
      return formatToolResult({ ok: true, data: payload });
    },
  });
}

// 2. docx_read
function registerDocxReadTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'docx_read',
    category: 'docx',
    description: D.docx_read,
    rules: ['read'],
    inputShape: {
      document_id: z.string().describe('文档 ID / Document ID (doc_token)'),
      max_images: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(0)
        .describe('最多自动下载几张图,默认 0(只返回 available_images 清单)。需要某张图时调 media_download 单拉,用户要求全看时传 20'),
    },
    handler: async ({ document_id, max_images }) => {
      return readDocWithImageManifest(document_id, max_images);
    },
  });
}

// 3. bitable_search
function registerBitableSearchTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_search',
    category: 'bitable',
    description: D.bitable_search,
    inputShape: {
      query: z.string().describe('搜索关键词 / Search keywords'),
    },
    handler: async ({ query }) => {
      const result = await searchDocs(query, [8], 20);
      if (!result.ok) return formatToolResult(result);

      const data = result.data as {
        docs_entities?: SearchResultItem[];
        has_more?: boolean;
      } | undefined;
      const items = (data?.docs_entities ?? []).map((d) => ({
        title: d.title,
        url: d.url,
        app_token: d.docs_token,
      }));

      const payload: Record<string, unknown> = { bitables: items };
      if (data?.has_more) {
        payload.hint = 'More results available. Narrow your query.';
      }
      return formatToolResult({ ok: true, data: payload });
    },
  });
}

// 4. bitable_list_tables
function registerBitableListTablesTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_list_tables',
    category: 'bitable',
    description: D.bitable_list_tables,
    inputShape: {
      app_token: z.string().describe('多维表格 app_token'),
    },
    handler: async ({ app_token }) => {
      const result = await readBitableTables(app_token);
      if (!result.ok) return formatToolResult(result);

      const data = result.data as {
        items?: Array<{
          table_id?: string;
          name?: string;
          revision?: number;
        }>;
      } | undefined;
      const items = (data?.items ?? []).map((t) => ({
        table_id: t.table_id,
        name: t.name,
        revision: t.revision,
      }));
      return formatToolResult({ ok: true, data: { tables: items } });
    },
  });
}

// 5. bitable_list_fields
function registerBitableListFieldsTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_list_fields',
    category: 'bitable',
    description: D.bitable_list_fields,
    inputShape: {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 ID / Table ID'),
    },
    handler: async ({ app_token, table_id }) => {
      const result = await callFeishu((c, opts) =>
        c.bitable.appTableField.list({ path: { app_token, table_id } }, opts),
      );
      if (!result.ok) return formatToolResult(result);

      const data = result.data as {
        items?: Array<{
          field_id?: string;
          field_name?: string;
          type?: number;
          property?: unknown;
        }>;
      } | undefined;
      const items = (data?.items ?? []).map((f) => ({
        field_id: f.field_id,
        field_name: f.field_name,
        type: f.type,
        property: f.property,
      }));
      return formatToolResult({ ok: true, data: { fields: items } });
    },
  });
}

// 6. bitable_list_records
function registerBitableListRecordsTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_list_records',
    category: 'bitable',
    description: D.bitable_list_records,
    rules: ['read'],
    inputShape: {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 ID / Table ID'),
      filter: z
        .string()
        .optional()
        .describe('筛选条件(飞书 filter 表达式,如 AND(CurrentValue.[状态]="进行中"))/ Filter expression'),
      ...paginationInput(20),
    },
    handler: async ({ app_token, table_id, filter, page_size, page_token }) => {
      const params: Record<string, unknown> = { page_size };
      if (filter) params.filter = filter;
      if (page_token) params.page_token = page_token;

      const result = await callFeishu((c, opts) =>
        c.bitable.appTableRecord.list(
          {
            params: params as {
              page_size?: number;
              filter?: string;
              page_token?: string;
            },
            path: { app_token, table_id },
          },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      const data = result.data as {
        items?: unknown[];
        has_more?: boolean;
        page_token?: string;
        total?: number;
      } | undefined;

      const payload = shapePage(
        data,
        'records',
        'More records available. Use a narrower filter or paginate.',
      );
      payload.total = data?.total;
      return formatToolResult({ ok: true, data: payload });
    },
  });
}

// ── bitable write helpers ──────────────────────────────────────────────────
//
// 字段类型走"友好枚举 + raw 兜底":常用 8 种(text/number/single_select/
// multi_select/date/checkbox/user/link)直接给参数,稀有类型用 type='raw' +
// raw_type / raw_ui_type / raw_property 把完整 SDK payload 透传。
//
// 飞书字段 type 数字 → 友好枚举映射:
//   1=Text 2=Number 3=SingleSelect 4=MultiSelect 5=DateTime 7=Checkbox
//   11=User 15=Url(其余 17=Attachment, 18=SingleLink, 20=Formula 等走 raw)

const BITABLE_FIELD_TYPE_ENUM = z.enum([
  'text',
  'number',
  'single_select',
  'multi_select',
  'date',
  'checkbox',
  'user',
  'link',
  'raw',
]);

const BITABLE_FIELD_SPEC = z.object({
  field_name: z.string().min(1).describe('字段名(在表内唯一)'),
  type: BITABLE_FIELD_TYPE_ENUM.describe(
    '字段类型友好枚举;稀有类型(公式/关联/附件等)用 raw + raw_type/raw_property',
  ),
  options: z
    .array(z.string())
    .optional()
    .describe('单选/多选时的候选项名称列表'),
  date_formatter: z
    .string()
    .optional()
    .describe('date 字段的展示格式,默认 yyyy/MM/dd'),
  user_multiple: z
    .boolean()
    .optional()
    .describe('user 字段是否允许多选,默认 false'),
  number_formatter: z
    .string()
    .optional()
    .describe('number 字段的格式,如 "0" / "0.00",默认 "0"'),
  raw_type: z
    .number()
    .int()
    .optional()
    .describe('type=raw 时必填:飞书原生 type 数字(见 open.feishu.cn 字段类型表)'),
  raw_ui_type: z
    .string()
    .optional()
    .describe('type=raw 时可选:飞书 ui_type 字符串'),
  raw_property: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('type=raw 时可选:完整 property 对象,直接透传给 SDK'),
});

interface BuiltBitableField {
  field_name: string;
  type: number;
  ui_type?: string;
  property?: Record<string, unknown>;
}

function buildBitableField(
  spec: z.infer<typeof BITABLE_FIELD_SPEC>,
): BuiltBitableField {
  const name = spec.field_name;
  switch (spec.type) {
    case 'text':
      return { field_name: name, type: 1, ui_type: 'Text' };
    case 'number':
      return {
        field_name: name,
        type: 2,
        ui_type: 'Number',
        property: { formatter: spec.number_formatter ?? '0' },
      };
    case 'single_select':
      if (!spec.options || spec.options.length === 0) {
        throw new Error('single_select 字段必须提供 options');
      }
      return {
        field_name: name,
        type: 3,
        ui_type: 'SingleSelect',
        property: { options: spec.options.map((n) => ({ name: n })) },
      };
    case 'multi_select':
      if (!spec.options || spec.options.length === 0) {
        throw new Error('multi_select 字段必须提供 options');
      }
      return {
        field_name: name,
        type: 4,
        ui_type: 'MultiSelect',
        property: { options: spec.options.map((n) => ({ name: n })) },
      };
    case 'date':
      return {
        field_name: name,
        type: 5,
        ui_type: 'DateTime',
        property: { date_formatter: spec.date_formatter ?? 'yyyy/MM/dd' },
      };
    case 'checkbox':
      return { field_name: name, type: 7, ui_type: 'Checkbox' };
    case 'user':
      return {
        field_name: name,
        type: 11,
        ui_type: 'User',
        property: { multiple: spec.user_multiple ?? false },
      };
    case 'link':
      return { field_name: name, type: 15, ui_type: 'Url' };
    case 'raw': {
      if (typeof spec.raw_type !== 'number') {
        throw new Error('type=raw 时必须提供 raw_type(飞书原生 type 数字)');
      }
      const out: BuiltBitableField = { field_name: name, type: spec.raw_type };
      if (spec.raw_ui_type) out.ui_type = spec.raw_ui_type;
      if (spec.raw_property) out.property = spec.raw_property;
      return out;
    }
  }
}

/**
 * 拼可点击的多维表格 URL。table_id / view_id 可选,带上能直接定位到那张表。
 */
function buildBitableUrl(
  appToken: string,
  tableId?: string,
  viewId?: string,
): string {
  const base = `${FEISHU_DOC_LINK_BASE}/base/${appToken}`;
  const qs: string[] = [];
  if (tableId) qs.push(`table=${tableId}`);
  if (viewId) qs.push(`view=${viewId}`);
  return qs.length > 0 ? `${base}?${qs.join('&')}` : base;
}

// 7. bitable_create_app
function registerBitableCreateAppTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_create_app',
    category: 'bitable',
    description: D.bitable_create_app,
    rules: ['bitable-edit', 'mutation-confirm'],
    inputShape: {
      name: z.string().min(1).describe('多维表格名称(在云空间显示的文件名)'),
      folder_token: z
        .string()
        .optional()
        .describe('目标云空间文件夹 token;不传 = 落到用户根目录'),
      time_zone: z
        .string()
        .optional()
        .describe('时区,默认 Asia/Shanghai'),
    },
    handler: async ({ name, folder_token, time_zone }) => {
      const result = await callFeishu((c, opts) =>
        c.bitable.app.create(
          {
            data: {
              name,
              ...(folder_token ? { folder_token } : {}),
              time_zone: time_zone ?? 'Asia/Shanghai',
            },
          },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      const app = (result.data as {
        app?: {
          app_token?: string;
          name?: string;
          folder_token?: string;
          url?: string;
          default_table_id?: string;
          time_zone?: string;
        };
      } | undefined)?.app;

      if (!app?.app_token) {
        return formatToolResult({
          ok: false,
          errorCode: 'CREATE_NO_APP',
          data: { msg: '飞书未返回 app_token', raw: result.data },
        });
      }

      return formatToolResult({
        ok: true,
        data: {
          app_token: app.app_token,
          name: app.name ?? name,
          default_table_id: app.default_table_id,
          folder_token: app.folder_token,
          time_zone: app.time_zone,
          url: app.url ?? buildBitableUrl(app.app_token, app.default_table_id),
          hint: '已建好空多维表格,可用 bitable_create_table 加表 / bitable_create_records 写记录',
        },
      });
    },
  });
}

// 8. bitable_create_table
function registerBitableCreateTableTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_create_table',
    category: 'bitable',
    description: D.bitable_create_table,
    rules: ['bitable-edit', 'mutation-confirm'],
    inputShape: {
      app_token: z.string().describe('多维表格 app_token'),
      name: z.string().min(1).describe('数据表名(app 内唯一)'),
      default_view_name: z
        .string()
        .optional()
        .describe('默认视图名,不传 = 飞书默认值"表格"'),
      fields: z
        .array(BITABLE_FIELD_SPEC)
        .optional()
        .describe('初始字段列表;不传 = 表只有飞书自动生成的索引字段'),
    },
    handler: async ({ app_token, name, default_view_name, fields }) => {
      let builtFields: BuiltBitableField[] | undefined;
      if (fields && fields.length > 0) {
        try {
          builtFields = fields.map(buildBitableField);
        } catch (e) {
          return formatToolResult({
            ok: false,
            errorCode: 'INVALID_ARGS',
            data: { msg: e instanceof Error ? e.message : String(e) },
          });
        }
      }

      const tablePayload: Record<string, unknown> = { name };
      if (default_view_name) tablePayload.default_view_name = default_view_name;
      if (builtFields) tablePayload.fields = builtFields;

      const result = await callFeishu((c, opts) =>
        c.bitable.appTable.create(
          {
            path: { app_token },
            data: { table: tablePayload as never },
          },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      const data = result.data as {
        table_id?: string;
        default_view_id?: string;
        field_id_list?: string[];
      } | undefined;

      return formatToolResult({
        ok: true,
        data: {
          table_id: data?.table_id,
          default_view_id: data?.default_view_id,
          field_ids: data?.field_id_list,
          url: buildBitableUrl(app_token, data?.table_id, data?.default_view_id),
        },
      });
    },
  });
}

// 9. bitable_delete_table
function registerBitableDeleteTableTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_delete_table',
    category: 'bitable',
    description: D.bitable_delete_table,
    rules: ['bitable-edit', 'mutation-confirm'],
    inputShape: {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('要删除的数据表 ID'),
    },
    handler: async ({ app_token, table_id }) => {
      const result = await callFeishu((c, opts) =>
        c.bitable.appTable.delete({ path: { app_token, table_id } }, opts),
      );
      if (!result.ok) return formatToolResult(result);
      return formatToolResult({
        ok: true,
        data: {
          deleted: true,
          app_token,
          table_id,
          url: buildBitableUrl(app_token),
        },
      });
    },
  });
}

// 10. bitable_create_field
function registerBitableCreateFieldTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_create_field',
    category: 'bitable',
    description: D.bitable_create_field,
    rules: ['bitable-edit', 'mutation-confirm'],
    inputShape: {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 ID'),
      field: BITABLE_FIELD_SPEC.describe('字段定义'),
    },
    handler: async ({ app_token, table_id, field }) => {
      let built: BuiltBitableField;
      try {
        built = buildBitableField(field);
      } catch (e) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGS',
          data: { msg: e instanceof Error ? e.message : String(e) },
        });
      }

      const result = await callFeishu((c, opts) =>
        c.bitable.appTableField.create(
          {
            path: { app_token, table_id },
            data: built as never,
          },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      const created = (result.data as {
        field?: { field_id?: string; field_name?: string; type?: number };
      } | undefined)?.field;

      return formatToolResult({
        ok: true,
        data: {
          field_id: created?.field_id,
          field_name: created?.field_name,
          type: created?.type,
          url: buildBitableUrl(app_token, table_id),
        },
      });
    },
  });
}

// 11. bitable_update_field
function registerBitableUpdateFieldTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_update_field',
    category: 'bitable',
    description: D.bitable_update_field,
    rules: ['bitable-edit', 'mutation-confirm'],
    inputShape: {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 ID'),
      field_id: z.string().describe('要修改的字段 field_id'),
      field: BITABLE_FIELD_SPEC.describe('新的字段定义(整体覆盖)'),
    },
    handler: async ({ app_token, table_id, field_id, field }) => {
      let built: BuiltBitableField;
      try {
        built = buildBitableField(field);
      } catch (e) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGS',
          data: { msg: e instanceof Error ? e.message : String(e) },
        });
      }

      const result = await callFeishu((c, opts) =>
        c.bitable.appTableField.update(
          {
            path: { app_token, table_id, field_id },
            data: built as never,
          },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      const updated = (result.data as {
        field?: { field_id?: string; field_name?: string; type?: number };
      } | undefined)?.field;

      return formatToolResult({
        ok: true,
        data: {
          field_id: updated?.field_id ?? field_id,
          field_name: updated?.field_name,
          type: updated?.type,
          url: buildBitableUrl(app_token, table_id),
        },
      });
    },
  });
}

// 12. bitable_delete_field
function registerBitableDeleteFieldTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_delete_field',
    category: 'bitable',
    description: D.bitable_delete_field,
    rules: ['bitable-edit', 'mutation-confirm'],
    inputShape: {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 ID'),
      field_id: z.string().describe('要删除的字段 field_id'),
    },
    handler: async ({ app_token, table_id, field_id }) => {
      const result = await callFeishu((c, opts) =>
        c.bitable.appTableField.delete(
          { path: { app_token, table_id, field_id } },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);
      return formatToolResult({
        ok: true,
        data: {
          deleted: true,
          field_id,
          url: buildBitableUrl(app_token, table_id),
        },
      });
    },
  });
}

// 13. bitable_create_records
function registerBitableCreateRecordsTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_create_records',
    category: 'bitable',
    description: D.bitable_create_records,
    rules: ['bitable-edit', 'mutation-confirm'],
    inputShape: {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 ID'),
      records: z
        .array(
          z.object({
            fields: z
              .record(z.string(), z.unknown())
              .describe('{ 字段名: 值 } 映射,字段名必须与表 schema 完全一致'),
          }),
        )
        .min(1)
        .max(1000)
        .describe('要创建的记录列表(单次最多 1000 条)'),
    },
    handler: async ({ app_token, table_id, records }) => {
      const result = await callFeishu((c, opts) =>
        c.bitable.appTableRecord.batchCreate(
          {
            path: { app_token, table_id },
            data: { records: records as never },
          },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      const created = (result.data as {
        records?: Array<{ record_id?: string }>;
      } | undefined)?.records ?? [];

      return formatToolResult({
        ok: true,
        data: {
          created_count: created.length,
          record_ids: created.map((r) => r.record_id).filter(Boolean),
          url: buildBitableUrl(app_token, table_id),
        },
      });
    },
  });
}

// 14. bitable_update_records
function registerBitableUpdateRecordsTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_update_records',
    category: 'bitable',
    description: D.bitable_update_records,
    rules: ['bitable-edit', 'mutation-confirm'],
    inputShape: {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 ID'),
      records: z
        .array(
          z.object({
            record_id: z.string().describe('要更新的记录 record_id'),
            fields: z
              .record(z.string(), z.unknown())
              .describe('要覆盖的字段(部分更新,只传要改的字段)'),
          }),
        )
        .min(1)
        .max(1000)
        .describe('要更新的记录列表(单次最多 1000 条)'),
    },
    handler: async ({ app_token, table_id, records }) => {
      const result = await callFeishu((c, opts) =>
        c.bitable.appTableRecord.batchUpdate(
          {
            path: { app_token, table_id },
            data: { records: records as never },
          },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      const updated = (result.data as {
        records?: Array<{ record_id?: string }>;
      } | undefined)?.records ?? [];

      return formatToolResult({
        ok: true,
        data: {
          updated_count: updated.length,
          record_ids: updated.map((r) => r.record_id).filter(Boolean),
          url: buildBitableUrl(app_token, table_id),
        },
      });
    },
  });
}

// 15. bitable_delete_records
function registerBitableDeleteRecordsTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'bitable_delete_records',
    category: 'bitable',
    description: D.bitable_delete_records,
    rules: ['bitable-edit', 'mutation-confirm'],
    inputShape: {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 ID'),
      record_ids: z
        .array(z.string().min(1))
        .min(1)
        .max(500)
        .describe('要删除的 record_id 数组(单次最多 500 条)'),
    },
    handler: async ({ app_token, table_id, record_ids }) => {
      const result = await callFeishu((c, opts) =>
        c.bitable.appTableRecord.batchDelete(
          {
            path: { app_token, table_id },
            data: { records: record_ids },
          },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      const deleted = (result.data as {
        records?: Array<{ deleted?: boolean; record_id?: string }>;
      } | undefined)?.records ?? [];

      return formatToolResult({
        ok: true,
        data: {
          deleted_count: deleted.filter((r) => r.deleted).length,
          requested_count: record_ids.length,
          url: buildBitableUrl(app_token, table_id),
        },
      });
    },
  });
}

// 7. wiki_search
function registerWikiSearchTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'wiki_search',
    category: 'wiki',
    description: D.wiki_search,
    inputShape: {
      query: z.string().describe('搜索关键词 / Search keywords'),
      space_id: z
        .string()
        .optional()
        .describe('限定知识空间 ID(可选)/ Optional wiki space ID to filter'),
    },
    handler: async ({ query, space_id }) => {
      const result = await searchDocs(query, [15], 20);
      if (!result.ok) return formatToolResult(result);

      const data = result.data as {
        docs_entities?: (SearchResultItem & { wiki_info?: { space_id?: string } })[];
        has_more?: boolean;
      } | undefined;

      let items = (data?.docs_entities ?? []).map((d) => ({
        title: d.title,
        url: d.url,
        node_token: d.docs_token,
        space_id: d.wiki_info?.space_id ?? 'unknown',
      }));

      if (space_id) {
        items = items.filter((i) => i.space_id === space_id);
      }

      const payload: Record<string, unknown> = { wiki_nodes: items };
      if (data?.has_more) {
        payload.hint = 'More results available. Narrow your query.';
      }
      if (space_id) {
        payload.filtered_by_space_id = space_id;
      }
      return formatToolResult({ ok: true, data: payload });
    },
  });
}

function registerWikiListSpacesTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'wiki_list_spaces',
    category: 'wiki',
    description: D.wiki_list_spaces,
    inputShape: {
      query: z
        .string()
        .optional()
        .describe('按知识空间名称做本地包含过滤 / Optional local name filter'),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe('每页数量,默认 20 / Page size'),
      page_token: z.string().optional().describe('翻页 token / Page token'),
    },
    handler: async ({ query, page_size, page_token }) => {
      const result = await callFeishu((c, opts) =>
        c.wiki.space.list(
          { params: { page_size, ...(page_token ? { page_token } : {}) } },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      const data = result.data as {
        items?: Array<{
          name?: string;
          description?: string;
          space_id?: string;
          space_type?: string;
          visibility?: string;
          open_sharing?: string;
        }>;
        page_token?: string;
        has_more?: boolean;
      } | undefined;

      const q = query?.trim().toLowerCase();
      const spaces = (data?.items ?? [])
        .filter((space) => (q ? (space.name ?? '').toLowerCase().includes(q) : true))
        .map((space) => ({
          name: space.name,
          description: space.description,
          space_id: space.space_id,
          space_type: space.space_type,
          visibility: space.visibility,
          open_sharing: space.open_sharing,
        }));

      return formatToolResult({
        ok: true,
        data: {
          spaces,
          has_more: data?.has_more,
          page_token: data?.page_token,
          filtered_by_query: query,
        },
      });
    },
  });
}

// 8. wiki_read
function registerWikiReadTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'wiki_read',
    category: 'wiki',
    description: D.wiki_read,
    rules: ['read'],
    inputShape: {
      space_id: z.string().optional().describe('知识空间 ID(可选)/ Wiki space ID (optional, not used for node resolution)'),
      node_id: z.string().describe('节点 token / Wiki node token'),
      max_images: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(0)
        .describe('最多自动下载几张图,默认 0(只返回 available_images 清单)。仅对 docx 节点有效;bitable 节点忽略此参数'),
    },
    handler: async ({ node_id, max_images }) => {
      const nodeResult = await callFeishu((c, opts) =>
        c.wiki.space.getNode({ params: { token: node_id } }, opts),
      );
      if (!nodeResult.ok) return formatToolResult(nodeResult);

      const nodeData = (nodeResult.data as { node?: { obj_token?: string; obj_type?: string } } | undefined)?.node;
      const objToken = nodeData?.obj_token;
      const objType = nodeData?.obj_type;

      if (!objToken) {
        return formatToolResult({ ok: false, errorCode: 'NOT_FOUND' });
      }

      if (objType === 'bitable') {
        const tablesResult = await readBitableTables(objToken);
        return formatToolResult(tablesResult);
      }
      if (objType === 'sheet') {
        return formatToolResult(await readSheetRange(objToken));
      }

      return readDocWithImageManifest(objToken, max_images);
    },
  });
}

// 9. wiki_list_children
function registerWikiListChildrenTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'wiki_list_children',
    category: 'wiki',
    description: D.wiki_list_children,
    inputShape: {
      space_id: z.string().describe('知识空间 ID / Wiki space ID'),
      node_id: z.string().describe('父节点 token / Parent node token'),
    },
    handler: async ({ space_id, node_id }) => {
      // 内部循环 page_token 拉完所有页,调用方拿到的是完整子节点列表
      const result = await paginateAll<{
        node_token?: string;
        title?: string;
        obj_type?: string;
        has_child?: boolean;
      }>((cursor) =>
        callFeishu((c, opts) =>
          c.wiki.spaceNode.list(
            {
              params: {
                parent_node_token: node_id,
                page_size: 50,
                ...(cursor ? { page_token: cursor } : {}),
              },
              path: { space_id },
            },
            opts,
          ),
        ),
      );
      if (!result.ok) return formatToolResult(result);

      const data = result.data as {
        items?: Array<{
          node_token?: string;
          title?: string;
          obj_type?: string;
          has_child?: boolean;
        }>;
      } | undefined;

      const items = (data?.items ?? []).map((n) => ({
        node_token: n.node_token,
        title: n.title,
        obj_type: n.obj_type,
        has_child: n.has_child,
      }));

      return formatToolResult({ ok: true, data: { children: items } });
    },
  });
}

function wikiNodeUrl(nodeToken?: string): string | undefined {
  return nodeToken ? `${FEISHU_DOC_LINK_BASE}/wiki/${nodeToken}` : undefined;
}

function parseOptionalTimestampSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseFeishuTimestampSeconds(value);
  if (!parsed.ok) return undefined;
  const n = Number(parsed.value);
  return Number.isFinite(n) ? n : undefined;
}

function formatIsoFromSeconds(seconds: number | undefined): string | undefined {
  if (seconds === undefined) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function userRef(id: string | undefined, userMap: Map<string, string>) {
  if (!id) return undefined;
  return { id, name: userMap.get(id) };
}

function compactContentPreview(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}...`;
}

function clampConcurrency(value: number): number {
  return Math.min(8, Math.max(1, Math.floor(value)));
}

function normalizeMaxScanNodes(value: number): number {
  return value > 0 ? value : Number.POSITIVE_INFINITY;
}

function driveMetaKey(docType: string | undefined, docToken: string | undefined): string | undefined {
  if (!docType || !docToken) return undefined;
  return `${docType}:${docToken}`;
}

function getDriveMetaForNode(
  node: WikiNodeItem,
  metaMap: Map<string, DriveMetaItem>,
): DriveMetaItem | undefined {
  const key = driveMetaKey(node.obj_type, node.obj_token);
  return key ? metaMap.get(key) : undefined;
}

async function fetchWikiNode(spaceId: string, nodeToken: string): Promise<FeishuApiResult> {
  return callFeishu((c, opts) =>
    c.wiki.space.getNode({ params: { token: nodeToken, obj_type: 'wiki' } }, opts),
  ).then((result) => {
    if (!result.ok) return result;
    const node = (result.data as { node?: WikiNodeItem } | undefined)?.node;
    return { ok: true, data: { node: node ? { ...node, space_id: node.space_id ?? spaceId } : undefined } };
  });
}

async function listWikiChildNodePage(
  spaceId: string,
  parentNodeToken: string | undefined,
  pageToken: string | undefined,
): Promise<FeishuApiResult> {
  return callFeishu((c, opts) =>
    c.wiki.spaceNode.list(
      {
        path: { space_id: spaceId },
        params: {
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
          ...(parentNodeToken ? { parent_node_token: parentNodeToken } : {}),
        },
      },
      opts,
    ),
  ).then((result) => {
    if (!result.ok) return result;
    const data = result.data as {
      items?: WikiNodeItem[];
      has_more?: boolean;
      page_token?: string;
    } | undefined;
    return {
      ok: true,
      data: {
        nodes: data?.items ?? [],
        has_more: Boolean(data?.has_more),
        page_token: data?.page_token,
      },
    };
  });
}

async function collectWikiNodes(
  spaceId: string,
  rootNodeToken: string | undefined,
  maxDepth: number,
  maxScanNodes: number,
  scanConcurrency: number,
): Promise<FeishuApiResult> {
  const nodes: WikiNodeItem[] = [];
  const queue: Array<{ token: string | undefined; depth: number; pageToken?: string }> = [];
  let truncated = false;
  const concurrency = clampConcurrency(scanConcurrency);
  const scanLimit = normalizeMaxScanNodes(maxScanNodes);

  if (rootNodeToken) {
    const rootResult = await fetchWikiNode(spaceId, rootNodeToken);
    if (!rootResult.ok) return rootResult;
    const root = (rootResult.data as { node?: WikiNodeItem } | undefined)?.node;
    if (root) {
      nodes.push(root);
      if (root.has_child && maxDepth > 0) queue.push({ token: root.node_token, depth: 1 });
    }
  } else {
    queue.push({ token: undefined, depth: 0 });
  }

  while (queue.length > 0 && nodes.length < scanLimit) {
    const batch = queue.splice(0, Math.min(concurrency, queue.length));
    const results = await Promise.all(
      batch.map(async (current) => {
        if (current.depth > maxDepth) return { current, skipped: true as const };
        const childResult = await listWikiChildNodePage(
          spaceId,
          current.token,
          current.pageToken,
        );
        return { current, childResult, skipped: false as const };
      }),
    );

    for (const item of results) {
      if (item.skipped) continue;
      if (!item.childResult.ok) return item.childResult;

      const data = item.childResult.data as {
        nodes?: WikiNodeItem[];
        has_more?: boolean;
        page_token?: string;
      };
      const children = data.nodes ?? [];
      const remaining = scanLimit - nodes.length;
      const accepted = remaining > 0 ? children.slice(0, remaining) : [];

      nodes.push(...accepted);
      if (accepted.length < children.length || (data.has_more && !data.page_token)) {
        truncated = true;
      }

      if (data.has_more && data.page_token && nodes.length < scanLimit) {
        queue.push({
          token: item.current.token,
          depth: item.current.depth,
          pageToken: data.page_token,
        });
      }

      for (const child of accepted) {
        if (child.has_child && child.node_token && item.current.depth < maxDepth) {
          queue.push({ token: child.node_token, depth: item.current.depth + 1 });
        }
      }

      if (nodes.length >= scanLimit) {
        truncated = true;
        break;
      }
    }
  }

  if (queue.length > 0 || nodes.length >= scanLimit) truncated = true;
  return { ok: true, data: { nodes, truncated, scan_concurrency: concurrency } };
}

/**
 * Map our internal embedded `type_name` (sheet / bitable / whiteboard / …)
 * to the `doc_type` string drive.meta.batchQuery expects. Returns undefined
 * for types drive.meta can't resolve (in-doc table, chat_card, sync_block,
 * iframe URL, …) — those won't have a fetchable title.
 *
 * Whiteboard is intentionally skipped: drive.meta returns FAILED for them
 * in most tenants. The block_43 entry still gets its URL and section_hint
 * surfaced; just no title.
 */
function embedTypeToDriveDocType(typeName: string): string | undefined {
  switch (typeName) {
    case 'sheet':
      return 'sheet';
    case 'bitable':
      return 'bitable';
    default:
      return undefined;
  }
}

/**
 * Embed type names whose ref/token is stored in `{main_token}_{sub_id}`
 * form by Feishu and therefore needs splitCompositeToken before passing to
 * drive.meta or constructing the canonical URL. Bitable's sub_id is a
 * table_id; sheet's sub_id is a sheet_tab_id. Everything else is
 * single-token.
 */
function needsCompositeSplit(typeName: string): boolean {
  return typeName === 'bitable' || typeName === 'sheet';
}

/**
 * Same idea for mention_doc obj_type → drive.meta doc_type. The internal
 * obj_type strings come from OBJ_TYPE_TO_TYPE_NAME in blockManifest.
 */
function objTypeToDriveDocType(objType: string): string | undefined {
  switch (objType) {
    case 'docx':
    case 'doc':
    case 'sheet':
    case 'bitable':
    case 'mindnote':
    case 'file':
    case 'wiki':
      return objType;
    case 'slide':
      return 'slides';
    default:
      return undefined;
  }
}

/**
 * Title + canonical URL for one entry resolved by drive.meta. The URL field
 * matters: tenant-aware URLs from drive.meta (e.g. `xindong.feishu.cn/slides/…`)
 * are the only ones that actually open the resource — bare `feishu.cn/…` URLs
 * we'd otherwise guess often 404 or land on a login page for non-default
 * tenants. We always prefer drive.meta's URL over our own inferred one.
 */
interface EmbedMeta {
  title?: string;
  url?: string;
}

/**
 * Result of a drive.meta batch — successful resolutions plus the set of
 * tokens that came back in `failed_list`. We need the failed set to mark
 * embedded entries as type-uncertain (e.g. a 画册 surfacing as bitable in
 * the docx tree but rejected by drive.meta as not-a-bitable).
 */
interface EmbedMetaResult {
  metaMap: Map<string, EmbedMeta>;
  failedTokens: Set<string>;
}

/**
 * Best-effort batch fetch of display titles + canonical URLs for every
 * embedded sheet/bitable and every mention_doc reference. One
 * drive.meta.batchQuery call (chunked to 100 per call) covers both lists.
 *
 * Returns a Map<token, {title, url}>. Missing tokens (unknown type,
 * drive.meta failed, permission denied) are simply absent — caller falls
 * back to the generic type label + the inferred URL. Failure NEVER throws;
 * it logs and returns whatever partial map was built (or an empty one).
 *
 * Network cost: one batchQuery in parallel with resolveOpenIdsToNames, so
 * adds at most max(N) latency rather than serial sum.
 */
async function fetchEmbedAndMentionTitles(
  embedded: EmbeddedBlockEntry[],
  mentionedDocs: MentionedDocEntry[],
): Promise<EmbedMetaResult> {
  const requestDocs: Array<{ doc_token: string; doc_type: string }> = [];
  const seen = new Set<string>(); // dedupe by token (cross-list dedupe)

  // Both bitable AND sheet embed refs can be composite (main_token + sub_id);
  // drive.meta requires only the main_token. Other types are single-token.
  for (const e of embedded) {
    if (!e.ref) continue;
    const docType = embedTypeToDriveDocType(e.type_name);
    if (!docType) continue;
    const lookupToken = needsCompositeSplit(e.type_name)
      ? splitCompositeToken(e.ref).main_token
      : e.ref;
    if (seen.has(lookupToken)) continue;
    seen.add(lookupToken);
    requestDocs.push({ doc_token: lookupToken, doc_type: docType });
  }

  for (const m of mentionedDocs) {
    if (!m.token) continue;
    const docType = objTypeToDriveDocType(m.obj_type);
    if (!docType) continue;
    const lookupToken = needsCompositeSplit(m.obj_type)
      ? splitCompositeToken(m.token).main_token
      : m.token;
    if (seen.has(lookupToken)) continue;
    seen.add(lookupToken);
    requestDocs.push({ doc_token: lookupToken, doc_type: docType });
  }

  const metaMap = new Map<string, EmbedMeta>();
  const failedTokens = new Set<string>();
  if (requestDocs.length === 0) return { metaMap, failedTokens };

  const batchSize = 100;
  for (let i = 0; i < requestDocs.length; i += batchSize) {
    const batch = requestDocs.slice(i, i + batchSize);
    const result = await callFeishu((c, opts) =>
      c.drive.meta.batchQuery(
        {
          // SDK types doc_type as a strict union; helper mappers above
          // only push known members, so the runtime values are valid. Cast
          // at the call boundary rather than tightening helper return
          // types (which would force callers to deal with a wider union).
          data: { request_docs: batch as never, with_url: true },
          params: { user_id_type: 'open_id' },
        },
        opts,
      ),
    );

    if (!result.ok) {
      log.warn(
        `fetchEmbedAndMentionTitles batch ${i}-${i + batch.length} failed: ${result.errorCode} — falling back to generic labels + guessed URLs for these entries`,
      );
      continue;
    }

    const data = result.data as
      | { metas?: DriveMetaItem[]; failed_list?: Array<{ token?: string; code?: number }> }
      | undefined;

    for (const meta of data?.metas ?? []) {
      if (!meta.doc_token) continue;
      const entry: EmbedMeta = {};
      if (typeof meta.title === 'string' && meta.title.length > 0) {
        entry.title = meta.title;
      }
      if (typeof meta.url === 'string' && meta.url.length > 0) {
        entry.url = meta.url;
      }
      if (entry.title || entry.url) metaMap.set(meta.doc_token, entry);
    }

    // Track tokens drive.meta rejected — likely type mismatch (e.g. 画册
    // surfaced as bitable in docx). Caller will mark these as uncertain
    // and drop our (probably wrong) inferred URL.
    for (const f of data?.failed_list ?? []) {
      if (typeof f.token === 'string' && f.token.length > 0) {
        failedTokens.add(f.token);
      }
    }
  }

  return { metaMap, failedTokens };
}

async function fetchDriveMetasForWikiNodes(nodes: WikiNodeItem[]): Promise<DriveMetaBatchResult> {
  const requestDocs: Array<{
    doc_token: string;
    doc_type: NonNullable<WikiNodeItem['obj_type']>;
  }> = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    const key = driveMetaKey(node.obj_type, node.obj_token);
    if (!key || seen.has(key) || !node.obj_type || !node.obj_token) continue;
    seen.add(key);
    requestDocs.push({ doc_token: node.obj_token, doc_type: node.obj_type });
  }

  const metaMap = new Map<string, DriveMetaItem>();
  const failed: Array<{ token: string; code: number }> = [];
  const errors: string[] = [];
  const batchSize = 100;

  for (let i = 0; i < requestDocs.length; i += batchSize) {
    const batch = requestDocs.slice(i, i + batchSize);
    const result = await callFeishu((c, opts) =>
      c.drive.meta.batchQuery(
        {
          data: { request_docs: batch, with_url: true },
          params: { user_id_type: 'open_id' },
        },
        opts,
      ),
    );

    if (!result.ok) {
      errors.push(result.errorCode ?? 'DRIVE_META_BATCH_FAILED');
      continue;
    }

    const data = result.data as
      | {
          metas?: DriveMetaItem[];
          failed_list?: Array<{ token?: string; code?: number }>;
        }
      | undefined;

    for (const meta of data?.metas ?? []) {
      const key = driveMetaKey(meta.doc_type, meta.doc_token);
      if (key) metaMap.set(key, meta);
    }
    for (const item of data?.failed_list ?? []) {
      if (item.token && item.code !== undefined) {
        failed.push({ token: item.token, code: item.code });
      }
    }
  }

  return { metaMap, requested: requestDocs.length, failed, errors };
}

type WikiChangeKind = 'edited' | 'created' | 'added';

interface WikiChangeCandidate {
  node: WikiNodeItem;
  edited_in_window?: number;   // obj_edit_time ∈ [start, end]
  created_in_window?: number;  // obj_create_time ∈ [start, end]
  added_in_window?: number;    // node_create_time ∈ [start, end]
  sort_ts: number;
  change_kinds: WikiChangeKind[];
}

function pickInWindow(ts: number | undefined, start: number, end: number): number | undefined {
  return ts !== undefined && ts >= start && ts <= end ? ts : undefined;
}

function computeChangeCandidate(
  node: WikiNodeItem,
  start: number,
  end: number,
): WikiChangeCandidate | undefined {
  const edited_in_window = pickInWindow(parseOptionalTimestampSeconds(node.obj_edit_time), start, end);
  const created_in_window = pickInWindow(parseOptionalTimestampSeconds(node.obj_create_time), start, end);
  const added_in_window = pickInWindow(parseOptionalTimestampSeconds(node.node_create_time), start, end);

  const change_kinds: WikiChangeKind[] = [];
  if (edited_in_window !== undefined) change_kinds.push('edited');
  if (created_in_window !== undefined) change_kinds.push('created');
  if (added_in_window !== undefined) change_kinds.push('added');
  if (change_kinds.length === 0) return undefined;

  const sort_ts = Math.max(
    edited_in_window ?? 0,
    created_in_window ?? 0,
    added_in_window ?? 0,
  );
  return { node, edited_in_window, created_in_window, added_in_window, sort_ts, change_kinds };
}

function applyEventFilter(
  cand: WikiChangeCandidate,
  filter: 'any' | 'edited_only' | 'new_only',
): boolean {
  if (filter === 'any') return true;
  if (filter === 'new_only') {
    return cand.change_kinds.includes('created') || cand.change_kinds.includes('added');
  }
  // edited_only: must be a pure edit — exclude anything that was also created/added in the window
  return cand.change_kinds.length === 1 && cand.change_kinds[0] === 'edited';
}

async function fetchDocContentPreview(
  node: WikiNodeItem,
  maxChars: number,
): Promise<{ preview?: string; error?: string }> {
  if (!node.obj_token || (node.obj_type !== 'docx' && node.obj_type !== 'doc')) {
    return {};
  }

  const result = await callFeishu((c, opts) =>
    c.docx.document.rawContent({ path: { document_id: node.obj_token! } }, opts),
  );
  if (!result.ok) {
    return { error: result.errorCode ?? 'FETCH_CONTENT_FAILED' };
  }
  const text = (result.data as { content?: string } | undefined)?.content ?? '';
  return { preview: compactContentPreview(text, maxChars) };
}

function buildWikiChangeItem(
  cand: WikiChangeCandidate,
  userMap: Map<string, string>,
  meta?: DriveMetaItem,
) {
  const node = cand.node;
  const title = node.title ?? '<untitled>';
  const url = meta?.url || wikiNodeUrl(node.node_token);
  const item: Record<string, unknown> = {
    title,
    title_markdown: url ? `[${title}](${url})` : title,
    url,
    change_kinds: cand.change_kinds,
    primary_event_time: formatIsoFromSeconds(cand.sort_ts),
    primary_event_timestamp: cand.sort_ts,
    edited_at: formatIsoFromSeconds(cand.edited_in_window),
    created_at: formatIsoFromSeconds(cand.created_in_window),
    added_at: formatIsoFromSeconds(cand.added_in_window),
    node_token: node.node_token,
    obj_token: node.obj_token,
    obj_type: node.obj_type,
    parent_node_token: node.parent_node_token,
    obj_create_time: formatIsoFromSeconds(parseOptionalTimestampSeconds(node.obj_create_time)),
    obj_edit_time: formatIsoFromSeconds(parseOptionalTimestampSeconds(node.obj_edit_time)),
    node_create_time: formatIsoFromSeconds(parseOptionalTimestampSeconds(node.node_create_time)),
    creator: userRef(node.creator, userMap),
    owner: userRef(node.owner, userMap),
    node_creator: userRef(node.node_creator, userMap),
  };
  if (meta) {
    item.latest_modify_time = formatIsoFromSeconds(parseOptionalTimestampSeconds(meta.latest_modify_time));
    item.latest_modify_user = userRef(meta.latest_modify_user, userMap);
    item.drive_owner = userRef(meta.owner_id, userMap);
    item.drive_create_time = formatIsoFromSeconds(parseOptionalTimestampSeconds(meta.create_time));
  }
  return item;
}

// 10. wiki_recent_changes
function registerWikiRecentChangesTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'wiki_recent_changes',
    category: 'wiki',
    description: D.wiki_recent_changes,
    inputShape: {
      space_id: z.string().describe('知识空间 ID / Wiki space ID'),
      start_time: z
        .string()
        .describe('起始时间,支持 Unix 秒/毫秒时间戳或 RFC3339/ISO;无时区时按 time_zone 或运行环境本地时区解析 / Start time'),
      end_time: z
        .string()
        .optional()
        .describe('结束时间,同 start_time 格式;不传则到当前时间 / End time'),
      time_zone: z
        .string()
        .optional()
        .describe('解析无时区日期时间时使用的时区,如 Asia/Shanghai、America/Los_Angeles 或 +08:00;不传则用运行环境本地时区 / Timezone for timezone-less date-times'),
      root_node_token: z
        .string()
        .optional()
        .describe('只扫描某个 Wiki 节点子树;不传则从知识空间根节点开始 / Optional subtree root node token'),
      event_filter: z
        .enum(['any', 'edited_only', 'new_only'])
        .default('any')
        .describe(
          '事件过滤;默认 any=任何活动(编辑/新建/挂入),edited_only=只看纯编辑(排除窗内新建/挂入),new_only=只看新出现的 / Event filter',
        ),
      obj_types: z
        .array(z.enum(['doc', 'docx', 'sheet', 'mindnote', 'bitable', 'file', 'slides']))
        .default(['doc', 'docx'])
        .describe('限定对象类型,默认只看 doc/docx 文档 / Object types to include'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(10)
        .describe('按时间倒序最多返回几条,默认 10 / Max results returned'),
      max_scan_nodes: z
        .number()
        .int()
        .min(0)
        .max(100000)
        .default(0)
        .describe('最多扫描多少个节点;0 表示不限制并扫描完整 space/子树 / Safety scan cap; 0 means scan all'),
      max_depth: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(8)
        .describe('递归扫描深度,默认 8 / Recursive scan depth'),
      scan_concurrency: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(4)
        .describe('扫描 Wiki 子节点时的并发数,默认 4,上限 8 / Concurrent child-list requests'),
      include_modifier: z
        .boolean()
        .default(false)
        .describe(
          '是否额外调 drive.meta.batchQuery 拿 latest_modify_user 等更精确字段,默认 false 以追求速度;开启后只对最终命中的节点调 / Opt-in drive.meta call for modifier info',
        ),
      include_content_preview: z
        .boolean()
        .default(false)
        .describe('是否给返回的 doc/docx 拉取当前正文预览,默认 false;这不是更新 diff / Include current content preview'),
      content_preview_chars: z
        .number()
        .int()
        .min(100)
        .max(2000)
        .default(600)
        .describe('每篇正文预览最多字符数 / Max preview chars per document'),
    },
    handler: async ({
      space_id,
      start_time,
      end_time,
      time_zone,
      root_node_token,
      event_filter,
      obj_types,
      limit,
      max_scan_nodes,
      max_depth,
      scan_concurrency,
      include_modifier,
      include_content_preview,
      content_preview_chars,
    }) => {
      const startTs = parseFeishuTimestampSeconds(start_time, { timeZone: time_zone });
      if (!startTs.ok) {
        return formatInvalidTimeResult('start_time', start_time, startTs.error);
      }
      const endTs = end_time
        ? parseFeishuTimestampSeconds(end_time, { timeZone: time_zone })
        : { ok: true as const, value: String(Math.floor(Date.now() / 1000)) };
      if (!endTs.ok) {
        return formatInvalidTimeResult('end_time', end_time ?? '', endTs.error);
      }

      const start = Number(startTs.value);
      const end = Number(endTs.value);
      if (start > end) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_TIME_RANGE',
          data: { start_time, end_time, start_timestamp: start, end_timestamp: end },
        });
      }

      const collected = await collectWikiNodes(
        space_id,
        root_node_token,
        max_depth,
        max_scan_nodes,
        scan_concurrency,
      );
      if (!collected.ok) return formatToolResult(collected);

      const collectData = collected.data as {
        nodes?: WikiNodeItem[];
        truncated?: boolean;
        scan_concurrency?: number;
      };
      const includeTypes = new Set(obj_types as WikiObjType[]);
      const typeFilteredNodes = (collectData.nodes ?? []).filter((node) =>
        node.obj_type ? includeTypes.has(node.obj_type) : false,
      );

      // Time-window filter BEFORE any drive call — uses wiki node fields only.
      const candidates = typeFilteredNodes
        .map((node) => computeChangeCandidate(node, start, end))
        .filter((c): c is WikiChangeCandidate => c !== undefined)
        .filter((c) => applyEventFilter(c, event_filter))
        .sort((a, b) => b.sort_ts - a.sort_ts)
        .slice(0, limit);

      // Optional drive.meta only for the surviving candidates.
      let driveMetas: DriveMetaBatchResult | undefined;
      if (include_modifier && candidates.length > 0) {
        driveMetas = await fetchDriveMetasForWikiNodes(candidates.map((c) => c.node));
      }

      // User-name resolution AFTER slice — only IDs we'll actually surface.
      const userIds = new Set<string>();
      for (const cand of candidates) {
        if (cand.node.creator) userIds.add(cand.node.creator);
        if (cand.node.owner) userIds.add(cand.node.owner);
        if (cand.node.node_creator) userIds.add(cand.node.node_creator);
      }
      if (driveMetas) {
        for (const meta of driveMetas.metaMap.values()) {
          if (meta.owner_id) userIds.add(meta.owner_id);
          if (meta.latest_modify_user) userIds.add(meta.latest_modify_user);
        }
      }
      const userMap = await resolveOpenIdsToNames(userIds);

      const changes = candidates.map((cand) => {
        const meta = driveMetas ? getDriveMetaForNode(cand.node, driveMetas.metaMap) : undefined;
        return buildWikiChangeItem(cand, userMap, meta);
      });

      if (include_content_preview) {
        for (let i = 0; i < changes.length; i += 1) {
          const cand = candidates[i];
          if (!cand) continue;
          const preview = await fetchDocContentPreview(cand.node, content_preview_chars);
          if (preview.preview) {
            changes[i].content_preview = preview.preview;
            changes[i].content_summary_note =
              'This is a current-content preview for summarization, not a Feishu update diff.';
          }
          if (preview.error) changes[i].content_preview_error = preview.error;
        }
      }

      return formatToolResult({
        ok: true,
        data: {
          query: {
            space_id,
            root_node_token,
            start_time: formatIsoFromSeconds(start),
            end_time: formatIsoFromSeconds(end),
            start_timestamp: start,
            end_timestamp: end,
            event_filter,
            obj_types,
            limit,
            max_depth,
            max_scan_nodes,
            scan_all_nodes: max_scan_nodes === 0,
            scan_concurrency: collectData.scan_concurrency ?? clampConcurrency(scan_concurrency),
            include_modifier,
            include_content_preview,
          },
          scanned_nodes: collectData.nodes?.length ?? 0,
          type_filtered_nodes: typeFilteredNodes.length,
          candidates_in_window: candidates.length,
          truncated: Boolean(collectData.truncated),
          ...(driveMetas
            ? {
                metadata_lookup: {
                  provider: 'drive.meta.batchQuery',
                  requested: driveMetas.requested,
                  resolved: driveMetas.metaMap.size,
                  failed_count: driveMetas.failed.length,
                  ...(driveMetas.failed.length > 0
                    ? { failed: driveMetas.failed.slice(0, 20) }
                    : {}),
                  ...(driveMetas.errors.length > 0 ? { errors: driveMetas.errors } : {}),
                },
              }
            : {}),
          changes,
          limitations: [
            'The Feishu wiki SDK exposes child-node listing but no server-side time filter/sort for a whole space; this tool still scans the tree, then filters by obj_edit_time/obj_create_time/node_create_time locally.',
            'change_kinds reflects which of (edited, created, added) timestamps fell in the window. "added" means an existing doc was attached to this wiki tree during the window (node_create_time).',
            'latest_modify_user is only populated when include_modifier=true (extra drive.meta.batchQuery call against the surviving candidates).',
            'content_preview is disabled by default for speed; when enabled, it is based on current document content and is not a version diff.',
          ],
        },
      });
    },
  });
}

// wiki_create_node
//
// 在指定知识空间下创建新节点(默认 docx 类型),支持挂在某个父节点下或空间根。
// 调用前必须由 Claude 走 AskUserQuestion 跟用户确认空间/父节点/标题/类型,
// 拿到明确"建"才能调本工具。代码层不再二次拦截。
function registerWikiCreateNodeTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'wiki_create_node',
    category: 'wiki',
    description: D.wiki_create_node,
    rules: ['mutation-confirm'],
    inputShape: {
      space_id: z.string().describe('知识空间 ID(必填,从 wiki URL 或 wiki_list_children 拿到)'),
      title: z.string().min(1).describe('文档标题'),
      parent_node_token: z
        .string()
        .optional()
        .describe('父节点 token;不传 = 建在空间根目录'),
      obj_type: z
        .enum(['docx', 'sheet', 'bitable', 'mindnote', 'file', 'slides', 'doc'])
        .default('docx')
        .describe('文档类型,默认 docx(新版云文档,推荐)'),
    },
    handler: async ({ space_id, title, parent_node_token, obj_type }) => {
      const result = await callFeishu((c, opts) =>
        c.wiki.spaceNode.create(
          {
            path: { space_id },
            data: {
              obj_type,
              node_type: 'origin',
              title,
              ...(parent_node_token ? { parent_node_token } : {}),
            },
          },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      const node = (result.data as {
        node?: {
          space_id?: string;
          node_token?: string;
          obj_token?: string;
          obj_type?: string;
          title?: string;
        };
      } | undefined)?.node;

      if (!node?.node_token) {
        return formatToolResult({
          ok: false,
          errorCode: 'CREATE_NO_NODE',
          data: { msg: '飞书未返回 node_token', raw: result.data },
        });
      }

      // 拼可点击的 wiki URL,方便用户直接打开
      const url = `${FEISHU_DOC_LINK_BASE}/wiki/${node.node_token}`;

      return formatToolResult({
        ok: true,
        data: {
          node_token: node.node_token,
          obj_token: node.obj_token,
          obj_type: node.obj_type,
          title: node.title ?? title,
          space_id: node.space_id ?? space_id,
          url,
          hint:
            obj_type === 'docx'
              ? '已建好空文档,可用 docx_append_blocks(传入 url 或 obj_token)往里面写内容'
              : '节点已建好,后续编辑请用对应类型的工具',
        },
      });
    },
  });
}

// ── Aggregate tool ─────────────────────────────────────────────────────────

// 10. search_and_read
function registerSearchAndReadTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'search_and_read',
    category: 'misc',
    description: D.search_and_read,
    rules: ['read'],
    inputShape: {
      query: z.string().describe('搜索关键词 / Search keywords'),
      max_docs: z
        .number()
        .default(5)
        .describe('最多拉取几篇,默认 5 / Max documents to fetch, default 5'),
      type: z
        .enum(['wiki', 'docx', 'bitable'])
        .optional()
        .describe('限定搜索范围 / Limit search scope: wiki, docx, or bitable'),
      max_images: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(0)
        .describe('每篇文档最多自动下载几张图,默认 0(只返回 available_images 清单)。多篇文档场景慎用大值会爆上下文'),
    },
    handler: async ({ query, max_docs, type, max_images }) => {
      const typeMap: Record<string, number[]> = {
        wiki: [15],
        docx: [22],
        bitable: [8],
      };
      const docsTypes = type ? typeMap[type] : [8, 15, 22];

      const searchResult = await searchDocs(query, docsTypes, max_docs);
      if (!searchResult.ok) return formatToolResult(searchResult);

      const searchData = searchResult.data as {
        docs_entities?: SearchResultItem[];
      } | undefined;
      const entities = searchData?.docs_entities ?? [];

      if (entities.length === 0) {
        return formatToolResult({
          ok: true,
          data: { documents: [], message: 'No documents found.' },
        });
      }

      // For each result we fetch its content. docx/wiki(docx) go through the
      // shared manifest-aware reader so they get available_images and (when
      // max_images > 0) inline image content blocks. We aggregate per-doc
      // image content blocks into the outermost return so Claude actually
      // "sees" them as vision input.
      type ImageBlock = { type: 'image'; data: string; mimeType: string };
      const aggregateImageBlocks: ImageBlock[] = [];

      const documents = await Promise.all(
        entities.map(async (entity) => {
          const docToken = entity.docs_token;
          const docType = entity.docs_type;
          const meta = {
            title: entity.title,
            url: entity.url,
            doc_token: docToken,
            docs_type: docType,
          };

          if (!docToken) {
            return { ...meta, content: null, error: 'Missing doc_token' };
          }

          try {
            // bitable: keep the raw table-list shape (no images).
            if (docType === 8) {
              const tables = await readBitableTables(docToken);
              if (!tables.ok) {
                return { ...meta, content: null, error: tables.errorCode };
              }
              const raw = JSON.stringify(tables.data);
              return { ...meta, content: JSON.parse(truncateContent(raw)) };
            }

            // wiki: resolve obj_token first, then dispatch by obj_type.
            let targetToken = docToken;
            let isBitable = false;
            if (docType === 15) {
              const nodeResult = await callFeishu((c, opts) =>
                c.wiki.space.getNode({ params: { token: docToken } }, opts),
              );
              if (!nodeResult.ok) {
                return { ...meta, content: null, error: nodeResult.errorCode };
              }
              const nodeData = (nodeResult.data as { node?: { obj_token?: string; obj_type?: string } } | undefined)?.node;
              const objToken = nodeData?.obj_token;
              if (!objToken) {
                return { ...meta, content: null, error: 'Cannot resolve wiki node' };
              }
              targetToken = objToken;
              isBitable = nodeData?.obj_type === 'bitable';
            }

            if (isBitable) {
              const tables = await readBitableTables(targetToken);
              if (!tables.ok) {
                return { ...meta, content: null, error: tables.errorCode };
              }
              const raw = JSON.stringify(tables.data);
              return { ...meta, content: JSON.parse(truncateContent(raw)) };
            }

            // docx (or docx-resolved wiki): use manifest-aware reader.
            const docResult = await readDocWithImageManifest(targetToken, max_images);
            // docResult shape: { content: [{type:'text',text:summaryJson}, ...image blocks] }
            //   OR formatToolResult shape on failure (also has `.content`)
            const blocks = (docResult as { content?: unknown[] }).content ?? [];
            const firstText = blocks.find(
              (b): b is { type: 'text'; text: string } =>
                typeof b === 'object' && b !== null &&
                (b as { type?: unknown }).type === 'text' &&
                typeof (b as { text?: unknown }).text === 'string',
            );
            // Collect image blocks from this doc into the aggregate so the
            // outer tool result can deliver them as vision input.
            for (const b of blocks) {
              if (
                typeof b === 'object' && b !== null &&
                (b as { type?: unknown }).type === 'image'
              ) {
                aggregateImageBlocks.push(b as ImageBlock);
              }
            }

            if (!firstText) {
              return { ...meta, content: null, error: 'EMPTY_RESULT' };
            }

            try {
              const summary = JSON.parse(firstText.text);
              const raw = JSON.stringify(summary);
              return { ...meta, content: JSON.parse(truncateContent(raw)) };
            } catch {
              // The text content wasn't JSON (e.g. an upstream error string).
              return { ...meta, content: firstText.text };
            }
          } catch {
            return { ...meta, content: null, error: 'FETCH_ERROR' };
          }
        }),
      );

      const summaryJson = JSON.stringify({ ok: true, documents });
      const outBlocks: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; data: string; mimeType: string }
      > = [{ type: 'text', text: summaryJson }, ...aggregateImageBlocks];
      return { content: outBlocks };
    },
  });
}

// ── IM tools ──────────────────────────────────────────────────────────────

/**
 * Resolve a set of open_ids to display names via contact.user.batch (chunked
 * by 50 — the API limit). Best-effort: if any chunk fails, the IDs in that
 * chunk are simply absent from the resulting map. Never throws.
 *
 * Used by im_read_messages to enrich each message's sender block with a
 * human-readable name, so downstream consumers (the LLM or a UI) don't need
 * to make a follow-up contact_batch_get_users call to know who said what.
 */
async function resolveOpenIdsToNames(
  openIds: Iterable<string>,
): Promise<Map<string, string>> {
  const idToName = new Map<string, string>();
  const all = Array.from(new Set(Array.from(openIds).filter(Boolean)));
  if (all.length === 0) return idToName;

  for (let i = 0; i < all.length; i += 50) {
    const chunk = all.slice(i, i + 50);
    const res = await callFeishu((c, opts) =>
      c.contact.user.batch(
        { params: { user_ids: chunk, user_id_type: 'open_id' } },
        opts,
      ),
    );
    if (!res.ok) {
      log.warn(
        `resolveOpenIdsToNames chunk ${i}-${i + chunk.length} failed: ${res.errorCode}`,
      );
      continue;
    }
    const items =
      (res.data as { items?: Array<{ open_id?: string; name?: string }> } | undefined)
        ?.items ?? [];
    for (const u of items) {
      if (u.open_id && u.name) idToName.set(u.open_id, u.name);
    }
  }
  return idToName;
}

type ImRawMessage = {
  sender?: { id?: string; id_type?: string; sender_type?: string };
  mentions?: Array<{ id?: string; id_type?: string }>;
  [k: string]: unknown;
};

type ImListMessagesOptions = {
  containerIdType: 'chat' | 'thread';
  containerId: string;
  pageSize: number;
  pageToken?: string;
  startTime?: string;
  endTime?: string;
  timeZone?: string;
  sortType?: 'ByCreateTimeAsc' | 'ByCreateTimeDesc';
  minPageSize: number;
  maxPageSize: number;
};

async function listImMessagesWithSenderNames(
  opts: ImListMessagesOptions,
): Promise<FeishuApiResult> {
  const effectivePageSize = Math.min(
    Math.max(opts.pageSize, opts.minPageSize),
    opts.maxPageSize,
  );
  const pageSizeCapped = opts.pageSize !== effectivePageSize;

  let startTs: string | undefined;
  if (opts.startTime) {
    const parsed = parseFeishuTimestampSeconds(opts.startTime, {
      timeZone: opts.timeZone,
    });
    if (!parsed.ok) {
      return {
        ok: false,
        errorCode: 'INVALID_TIME',
        data: {
          field: 'start_time',
          value: opts.startTime,
          reason: parsed.error,
          hint: 'Use Unix timestamp seconds, Unix timestamp milliseconds, or RFC3339/ISO time. Date-times without timezone are interpreted in time_zone when provided, otherwise in the host local timezone.',
        },
      };
    }
    startTs = parsed.value;
  }

  let endTs: string | undefined;
  if (opts.endTime) {
    const parsed = parseFeishuTimestampSeconds(opts.endTime, {
      timeZone: opts.timeZone,
    });
    if (!parsed.ok) {
      return {
        ok: false,
        errorCode: 'INVALID_TIME',
        data: {
          field: 'end_time',
          value: opts.endTime,
          reason: parsed.error,
          hint: 'Use Unix timestamp seconds, Unix timestamp milliseconds, or RFC3339/ISO time. Date-times without timezone are interpreted in time_zone when provided, otherwise in the host local timezone.',
        },
      };
    }
    endTs = parsed.value;
  }

  const result = await callFeishu((c, authOpts) =>
    c.im.message.list(
      {
        params: {
          container_id_type: opts.containerIdType,
          container_id: opts.containerId,
          page_size: effectivePageSize,
          ...(startTs ? { start_time: startTs } : {}),
          ...(endTs ? { end_time: endTs } : {}),
          ...(opts.sortType ? { sort_type: opts.sortType } : {}),
          ...(opts.pageToken ? { page_token: opts.pageToken } : {}),
        },
      },
      authOpts,
    ),
  );
  if (!result.ok) return result;

  const data = result.data as
    | { items?: ImRawMessage[]; has_more?: boolean; page_token?: string }
    | undefined;

  const messages = (data?.items ?? []) as ImRawMessage[];

  const openIds = new Set<string>();
  for (const m of messages) {
    if (m.sender?.id_type === 'open_id' && m.sender.id) {
      openIds.add(m.sender.id);
    }
    if (Array.isArray(m.mentions)) {
      for (const mention of m.mentions) {
        if (mention?.id_type === 'open_id' && mention.id) {
          openIds.add(mention.id);
        }
      }
    }
  }

  const userMap = await resolveOpenIdsToNames(openIds);
  for (const m of messages) {
    const sid = m.sender?.id;
    if (sid && userMap.has(sid)) {
      (m.sender as Record<string, unknown>).sender_name = userMap.get(sid);
    }
  }

  const userMapObj: Record<string, string> = {};
  for (const [k, v] of userMap) userMapObj[k] = v;

  const payload: Record<string, unknown> = {
    messages,
    user_map: userMapObj,
  };
  const hints: string[] = [];
  if (pageSizeCapped) {
    payload.requested_page_size = opts.pageSize;
    payload.applied_page_size = effectivePageSize;
    hints.push(
      `page_size=${opts.pageSize} 超出飞书该接口允许范围 [${opts.minPageSize},${opts.maxPageSize}],已按 ${effectivePageSize} 取本页;需要更多请用 page_token 翻页。`,
    );
  }
  if (data?.has_more) {
    payload.has_more = true;
    payload.page_token = data.page_token;
    hints.push('More messages available. Pass the page_token to paginate.');
  }
  if (hints.length > 0) payload.hint = hints.join(' ');

  return { ok: true, data: payload };
}

async function resolveImThreadId(threadOrMessageId: string): Promise<FeishuApiResult> {
  if (threadOrMessageId.startsWith('omt_')) {
    return { ok: true, data: { thread_id: threadOrMessageId } };
  }
  if (!threadOrMessageId.startsWith('om_')) {
    return {
      ok: false,
      errorCode: 'INVALID_ARGS',
      data: {
        message:
          'thread_id 必须以 omt_ 开头,或传入以 om_ 开头的主消息 message_id 用于自动解析 thread_id。',
      },
    };
  }

  const result = await callFeishu((c, opts) =>
    c.im.message.get({ path: { message_id: threadOrMessageId } }, opts),
  );
  if (!result.ok) return result;

  const data = result.data as { items?: Array<{ thread_id?: string }> } | undefined;
  const threadId = data?.items?.find((item) => item.thread_id)?.thread_id;
  if (!threadId) {
    return {
      ok: false,
      errorCode: 'NOT_FOUND',
      data: {
        message_id: threadOrMessageId,
        message: '未能从该 message_id 解析到 thread_id。',
      },
    };
  }

  return { ok: true, data: { thread_id: threadId } };
}

function normalizeChatSearchQuery(query: string): string {
  try {
    const parsed = JSON.parse(query) as unknown;
    if (typeof parsed === 'string') query = parsed;
  } catch {
    // Keep raw input when it is not already JSON-quoted.
  }
  if (!query.includes('-')) return query;
  return JSON.stringify(query);
}

function mapSearchChatModes(modes: Array<'group' | 'topic'> | undefined): string[] {
  const mapped: string[] = [];
  const seen = new Set<string>();
  for (const mode of modes ?? []) {
    const wire = mode === 'topic' ? 'thread' : 'default';
    if (seen.has(wire)) continue;
    seen.add(wire);
    mapped.push(wire);
  }
  return mapped;
}

function buildChatSearchBody(args: {
  query?: string;
  search_types?: Array<
    'private' | 'external' | 'public_joined' | 'public_not_joined'
  >;
  chat_modes?: Array<'group' | 'topic'>;
  member_ids?: string[];
  is_manager?: boolean;
  disable_search_by_user?: boolean;
  sort?: 'create_time' | 'update_time' | 'member_count';
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const query = args.query?.trim();
  if (query) {
    body.query = normalizeChatSearchQuery(query);
  }

  const filter: Record<string, unknown> = {};
  if (args.search_types?.length) {
    filter.search_types = args.search_types;
  }
  const chatModes = mapSearchChatModes(args.chat_modes);
  if (chatModes.length) {
    filter.chat_modes = chatModes;
  }
  if (args.member_ids?.length) {
    filter.member_ids = args.member_ids;
  }
  if (args.is_manager) {
    filter.is_manager = true;
  }
  if (args.disable_search_by_user) {
    filter.disable_search_by_user = true;
  }
  if (Object.keys(filter).length) {
    body.filter = filter;
  }

  const sorter = args.sort
    ? {
        create_time: 'create_time_desc',
        update_time: 'update_time_desc',
        member_count: 'member_count_desc',
      }[args.sort]
    : undefined;
  if (sorter) {
    body.sorter = sorter;
  }

  return body;
}

function shouldUseChatSearch(args: {
  query?: string;
  search_types?: unknown[];
  chat_modes?: unknown[];
  member_ids?: unknown[];
  is_manager?: boolean;
  disable_search_by_user?: boolean;
  sort?: string;
  exact_name?: boolean;
}): boolean {
  return Boolean(
    args.query?.trim() ||
      args.search_types?.length ||
      args.chat_modes?.length ||
      args.member_ids?.length ||
      args.is_manager ||
      args.disable_search_by_user ||
      args.sort ||
      args.exact_name,
  );
}

function shapeChatSearchResult(
  data:
    | {
        items?: Array<Record<string, unknown> & { meta_data?: Record<string, unknown> }>;
        total?: number;
        has_more?: boolean;
        page_token?: string;
      }
    | undefined,
  query: string | undefined,
  exactName: boolean | undefined,
  nextPageArgs: Record<string, unknown>,
): Record<string, unknown> {
  const rawChats =
    data?.items
      ?.map((item) => item.meta_data ?? item)
      .filter((item): item is Record<string, unknown> => Boolean(item)) ?? [];
  const nameFiltered = Boolean(exactName && query?.trim());
  const chats = nameFiltered
    ? rawChats.filter((chat) => chat.name === query?.trim())
    : rawChats;

  const payload: Record<string, unknown> = {
    chats,
    total: nameFiltered ? chats.length : (data?.total ?? chats.length),
  };
  if (nameFiltered) {
    payload.exact_name = true;
    payload.search_total = data?.total ?? rawChats.length;
  }
  if (data?.has_more) {
    payload.has_more = true;
    payload.page_token = data.page_token;
    payload.next_page_args = { ...nextPageArgs, page_token: data.page_token };
    payload.hint =
      'More chats available. Call im_list_chats with next_page_args to keep using chat search pagination.';
  }
  return payload;
}

function normalizeImMessageContent(msgType: string, content: string): string {
  if (msgType !== 'text') return content;

  let alreadyJson = false;
  try {
    const parsed = JSON.parse(content);
    alreadyJson = typeof parsed === 'object' && parsed !== null;
  } catch {
    alreadyJson = false;
  }
  return alreadyJson ? content : JSON.stringify({ text: content });
}

// 11. im_list_chats
function registerImListChatsTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'im_list_chats',
    category: 'im',
    description: D.im_list_chats,
    inputShape: {
      query: z
        .string()
        .optional()
        .describe(
          '群名/会话名核心关键词。优先传核心词,如“小镇工程师群”先搜“小镇工程师”或“工程师”;传入后走飞书服务端群搜索;名称含连字符时会自动整串加引号 / Chat name keyword',
        ),
      search_types: z
        .array(z.enum(['private', 'external', 'public_joined', 'public_not_joined']))
        .optional()
        .describe(
          '搜索范围过滤 / Search type filter: private, external, public_joined, public_not_joined',
        ),
      chat_modes: z
        .array(z.enum(['group', 'topic']))
        .optional()
        .describe('会话模式过滤:group=普通群,topic=话题群 / Chat mode filter'),
      member_ids: z
        .array(z.string())
        .optional()
        .describe('成员 open_id 列表过滤,最多 50 个 / Member open_id filter'),
      is_manager: z
        .boolean()
        .default(false)
        .describe('只返回当前用户创建或管理的群 / Only chats managed by current user'),
      disable_search_by_user: z
        .boolean()
        .default(false)
        .describe(
          '禁用按成员名称搜索,优先按群名搜索 / Disable search by member name',
        ),
      sort: z
        .enum(['create_time', 'update_time', 'member_count'])
        .optional()
        .describe('搜索排序字段,固定倒序 / Search sort field, descending'),
      exact_name: z
        .boolean()
        .default(false)
        .describe(
          '按完整群名做 MCP 侧精确后过滤。优先用于搜索结果过多且已确认完整 name 的场景 / Exact chat name post-filter',
        ),
      sort_type: z
        .enum(['ByCreateTimeAsc', 'ByActiveTimeDesc'])
        .optional()
        .describe(
          '仅列表模式(不带 query 等搜索参数)生效:ByActiveTimeDesc=按会话活跃时间倒序(取"最近有新消息的会话"用它);默认按创建时间升序 / List-mode sort; ByActiveTimeDesc surfaces recently-active chats',
        ),
      ...paginationInput(20),
    },
    handler: async (args) => {
      const {
        query,
        search_types,
        chat_modes,
        member_ids,
        is_manager,
        disable_search_by_user,
        sort,
        exact_name,
        sort_type,
        page_size,
        page_token,
      } = args;

      if (shouldUseChatSearch(args)) {
        if (!query?.trim() && !member_ids?.length) {
          return formatToolResult({
            ok: false,
            errorCode: 'INVALID_ARGS',
            data: {
              message: '搜索群组时必须传 query 或 member_ids。',
            },
          });
        }
        if (query && [...query].length > 64) {
          return formatToolResult({
            ok: false,
            errorCode: 'INVALID_ARGS',
            data: {
              message: 'query 最长 64 个字符。',
            },
          });
        }
        if (member_ids && member_ids.length > 50) {
          return formatToolResult({
            ok: false,
            errorCode: 'INVALID_ARGS',
            data: {
              message: 'member_ids 最多 50 个。',
            },
          });
        }

        const appliedPageSize = Math.min(Math.max(page_size, 1), 100);
        const result = await callOpenApi('POST', '/open-apis/im/v2/chats/search', {
          params: {
            page_size: appliedPageSize,
            ...(page_token ? { page_token } : {}),
          },
          data: buildChatSearchBody({
            query,
            search_types,
            chat_modes,
            member_ids,
            is_manager,
            disable_search_by_user,
            sort,
          }),
        });
        if (!result.ok) return formatToolResult(result);

        const payload = shapeChatSearchResult(
          result.data as
            | {
                items?: Array<
                  Record<string, unknown> & { meta_data?: Record<string, unknown> }
                >;
                total?: number;
                has_more?: boolean;
                page_token?: string;
              }
            | undefined,
          query,
          exact_name,
          {
            ...(query ? { query } : {}),
            ...(search_types?.length ? { search_types } : {}),
            ...(chat_modes?.length ? { chat_modes } : {}),
            ...(member_ids?.length ? { member_ids } : {}),
            ...(is_manager ? { is_manager } : {}),
            ...(disable_search_by_user ? { disable_search_by_user } : {}),
            ...(sort ? { sort } : {}),
            ...(exact_name ? { exact_name } : {}),
            page_size: appliedPageSize,
          },
        );
        if (page_size !== appliedPageSize) {
          payload.requested_page_size = page_size;
          payload.applied_page_size = appliedPageSize;
          payload.hint = payload.hint
            ? `${payload.hint} page_size was clamped to ${appliedPageSize}.`
            : `page_size was clamped to ${appliedPageSize}.`;
        }

        return formatToolResult({ ok: true, data: payload });
      }

      const result = await callFeishu((c, opts) =>
        c.im.chat.list(
          {
            params: {
              page_size,
              ...(sort_type ? { sort_type } : {}),
              ...(page_token ? { page_token } : {}),
            },
          },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      return formatToolResult({
        ok: true,
        data: shapePage(
          result.data as
            | { items?: unknown[]; has_more?: boolean; page_token?: string }
            | undefined,
          'chats',
        ),
      });
    },
  });
}

// 12. im_read_messages
function registerImReadMessagesTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'im_read_messages',
    category: 'im',
    description: D.im_read_messages,
    rules: ['read'],
    inputShape: {
      container_id: z
        .string()
        .optional()
        .describe(
          '容器 ID。container_id_type=chat 时传群组或对话 ID(chat_id);container_id_type=thread 时传话题串 ID(thread_id,通常 omt_*) / Container ID, chat_id or thread_id depending on container_id_type',
        ),
      container_id_type: z
        .enum(['chat', 'thread'])
        .default('chat')
        .describe(
          '容器类型,默认 chat。读群聊/单聊用 chat;读话题回复用 thread / Container type, default chat',
        ),
      open_id: z
        .string()
        .optional()
        .describe(
          '对方用户 open_id。仅 container_id_type=chat 时可用,传它且不传 container_id 时自动反查单聊 chat_id / Peer open_id; chat mode only',
        ),
      message_id: z
        .string()
        .optional()
        .describe(
          '主消息 ID(om_*),仅 container_id_type=thread 时可用;工具会先解析 thread_id 再读取话题回复 / Root message ID; thread mode only',
        ),
      start_time: z
        .string()
        .optional()
        .describe('起始时间,支持 Unix 秒/毫秒时间戳或 RFC3339/ISO;无时区时按 time_zone 或运行环境本地时区解析。强烈建议传入以限定范围 / Start time, Unix seconds/milliseconds or RFC3339/ISO'),
      end_time: z
        .string()
        .optional()
        .describe('结束时间,同 start_time 格式;不传则到当前时间 / End time, same format as start_time, defaults to now'),
      time_zone: z
        .string()
        .optional()
        .describe('解析无时区日期时间时使用的时区,如 Asia/Shanghai、America/Los_Angeles 或 +08:00;不传则用运行环境本地时区 / Timezone for timezone-less date-times'),
      sort_type: z
        .enum(['ByCreateTimeDesc', 'ByCreateTimeAsc'])
        .optional()
        .describe(
          '按创建时间排序。chat 模式默认 ByCreateTimeDesc 直接读最新消息;thread 模式默认 ByCreateTimeAsc 便于按时间线阅读回复 / Sort by create time',
        ),
      ...paginationInput(20),
      // 覆盖共享 paginationInput 的 page_size describe:飞书 im/v1/messages 接口
      // page_size 硬上限 50,这里写明区间让模型主动传 ≤50;超过会在 handler 静默
      // 钳到 50 并在返回 hint 里说明,不让请求裸撞飞书 400。
      page_size: z
        .number()
        .default(20)
        .describe('每页数量,1-50,默认 20;越界会被自动钳制 / Page size 1-50, default 20'),
    },
    handler: async ({
      container_id,
      container_id_type,
      open_id,
      message_id,
      start_time,
      end_time,
      time_zone,
      sort_type,
      page_size,
      page_token,
    }) => {
      if (container_id_type === 'chat' && message_id) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGS',
          data: {
            message:
              'message_id 仅用于 container_id_type=thread 的话题回复读取。读取普通群聊/单聊时请传 container_id 或 open_id。',
          },
        });
      }
      if (container_id_type === 'thread' && open_id) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGS',
          data: {
            message:
              'open_id 仅用于 container_id_type=chat 的单聊读取。读取话题回复时请传 container_id(thread_id) 或 message_id。',
          },
        });
      }

      let targetContainerId: string | undefined;
      let sourceMessageId: string | undefined;
      if (container_id_type === 'thread') {
        if (start_time || end_time) {
          return formatToolResult({
            ok: false,
            errorCode: 'INVALID_ARGS',
            data: {
              message:
                '飞书 thread 消息列表不支持 start_time/end_time 过滤。读取 thread 时请使用 page_token 翻页。',
              unsupported_fields: [
                ...(start_time ? ['start_time'] : []),
                ...(end_time ? ['end_time'] : []),
              ],
            },
          });
        }
        if (!container_id && !message_id) {
          return formatToolResult({
            ok: false,
            errorCode: 'INVALID_ARGS',
            data: {
              message:
                'container_id_type=thread 时,container_id(thread_id) 与 message_id 至少传一个。',
            },
          });
        }
        if (container_id?.startsWith('omt_')) {
          if (message_id) {
            const resolved = await resolveImThreadId(message_id);
            if (!resolved.ok) return formatToolResult(resolved);
            const resolvedThreadId = (resolved.data as { thread_id?: string } | undefined)
              ?.thread_id;
            if (resolvedThreadId !== container_id) {
              return formatToolResult({
                ok: false,
                errorCode: 'INVALID_ARGS',
                data: {
                  container_id,
                  message_id,
                  resolved_thread_id: resolvedThreadId,
                  message:
                    'container_id(thread_id) 与 message_id 解析出的 thread_id 不一致。',
                },
              });
            }
            sourceMessageId = message_id;
          }
          targetContainerId = container_id;
        } else if (container_id && message_id) {
          return formatToolResult({
            ok: false,
            errorCode: 'INVALID_ARGS',
            data: {
              message:
                'container_id_type=thread 时,container_id 传 thread_id(omt_*)即可;如果只有主消息 ID,只传 message_id(om_*)。',
            },
          });
        } else if (message_id) {
          const resolved = await resolveImThreadId(message_id);
          if (!resolved.ok) return formatToolResult(resolved);
          targetContainerId = (resolved.data as { thread_id?: string } | undefined)
            ?.thread_id;
          sourceMessageId = message_id;
        } else {
          const resolved = await resolveImThreadId(container_id ?? '');
          if (!resolved.ok) return formatToolResult(resolved);
          targetContainerId = (resolved.data as { thread_id?: string } | undefined)
            ?.thread_id;
        }
        if (!targetContainerId) {
          return formatToolResult({
            ok: false,
            errorCode: 'FEISHU_API_ERROR',
            data: {
              message:
                'thread_id 解析返回成功但缺少 thread_id,疑似飞书接口响应异常 / Resolver returned ok without a thread_id.',
            },
          });
        }
      } else {
        if (!container_id && !open_id) {
          return formatToolResult({
            ok: false,
            errorCode: 'INVALID_ARGS',
            data: {
              message:
                'container_id 与 open_id 至少传一个。读取群聊传 container_id; 读取单聊可传对方 open_id 自动反查 chat_id。',
            },
          });
        }
        if (container_id && open_id) {
          return formatToolResult({
            ok: false,
            errorCode: 'INVALID_ARGS',
            data: {
              message:
                'container_id 与 open_id 只能传一个。已知 chat_id 时传 container_id; 读取单聊时传对方 open_id。',
            },
          });
        }

        targetContainerId = container_id;
        if (!targetContainerId && open_id) {
          const p2pResult = await resolveP2pChatId(open_id);
          if (!p2pResult.ok) return formatToolResult(p2pResult);
          targetContainerId = (p2pResult.data as { chat_id?: string } | undefined)
            ?.chat_id;
        }
        if (!targetContainerId) {
          return formatToolResult({
            ok: false,
            errorCode: 'FEISHU_API_ERROR',
            data: {
              message:
                'p2p chat_id 反查返回成功但缺少 chat_id,疑似飞书接口响应异常 / Resolver returned ok without a chat_id (unexpected Feishu API response).',
            },
          });
        }
      }

      const result = await listImMessagesWithSenderNames({
        containerIdType: container_id_type,
        containerId: targetContainerId,
        pageSize: page_size,
        pageToken: page_token,
        startTime: start_time,
        endTime: end_time,
        timeZone: time_zone,
        sortType:
          sort_type ??
          (container_id_type === 'thread' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc'),
        minPageSize: 1,
        maxPageSize: 50,
      });
      if (!result.ok) return formatToolResult(result);

      if (container_id_type === 'thread') {
        const data = (result.data as Record<string, unknown> | undefined) ?? {};
        result.data = {
          thread_id: targetContainerId,
          ...(sourceMessageId ? { source_message_id: sourceMessageId } : {}),
          ...data,
        };
      }

      const raw = JSON.stringify(result.data);
      if (Buffer.byteLength(raw, 'utf-8') > MAX_CONTENT_BYTES) {
        const truncated = truncateContent(raw);
        return {
          content: [{ type: 'text' as const, text: truncated }],
        };
      }

      return formatToolResult({ ok: true, data: result.data });
    },
  });
}

// 12.4 im_search_messages
// Cross-chat keyword search over the current user's *visible* messages
// (visibility identical to the in-app suite search). Feishu models this as a
// POST (`/open-apis/search/v2/message`) that returns only message_ids, so it is
// NOT reachable via the GET-only generated passthrough and has no equivalent in
// `im_read_messages` (which needs a known chat_id). By default each hit is
// hydrated to the same enriched message shape `im_read_messages` returns
// (content + best-effort sender_name), so the caller doesn't need a follow-up
// fetch.
//
// SCOPES (confirmed in review, 2026-06): the search itself needs the dedicated
// `search:message` user scope — it does NOT piggyback on `im:message:readonly`.
// Hydrating p2p (direct-message) hits via `im.message.get` additionally needs a
// p2p get-as-user read scope. Both must be enabled in the Feishu app console by
// the owner and added to the desktop OAuth request before this tool returns data
// live; until then `search` returns a scope error and p2p hydration degrades to
// per-hit `fetch_error` (use `hydrate=false` to skip p2p body reads entirely).
function registerImSearchMessagesTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'im_search_messages',
    category: 'im',
    description: D.im_search_messages,
    rules: ['read'],
    inputShape: {
      query: z.string().min(1).describe('搜索关键词 / Search keyword'),
      from_ids: z
        .array(z.string())
        .optional()
        .describe('按发送者 open_id 过滤 / Filter by sender open_ids'),
      chat_ids: z
        .array(z.string())
        .optional()
        .describe('限定在这些会话内搜索(chat_id) / Restrict to these chat ids'),
      at_chatter_ids: z
        .array(z.string())
        .optional()
        .describe('按被 @ 的用户 open_id 过滤 / Filter by @-mentioned user open_ids'),
      from_type: z
        .enum(['bot', 'user'])
        .optional()
        .describe('发送者类型过滤 / Sender type filter: bot / user'),
      chat_type: z
        .enum(['group_chat', 'p2p_chat'])
        .optional()
        .describe('会话类型过滤 / Chat type filter: group_chat / p2p_chat'),
      message_type: z
        .enum(['file', 'image', 'media'])
        .optional()
        .describe('仅搜资源消息类型 / Resource message type filter: file / image / media'),
      page_size: z
        .number()
        .int()
        .default(20)
        .describe('每页命中数,1-20(越界自动钳制) / Page size, 1-20'),
      page_token: z.string().optional().describe('翻页 token / Pagination token'),
      hydrate: z
        .boolean()
        .default(true)
        .describe(
          '默认 true:对每条命中调 im.message.get 拉正文并补 sender_name,返回与 im_read_messages 一致的富消息;false 只返回 message_id 列表(更快) / Hydrate each hit into a full enriched message; false returns only message_ids',
        ),
    },
    handler: async ({
      query,
      from_ids,
      chat_ids,
      at_chatter_ids,
      from_type,
      chat_type,
      message_type,
      page_size,
      page_token,
      hydrate,
    }) => {
      const appliedPageSize = Math.min(Math.max(page_size, 1), 20);
      const search = await callOpenApi('POST', '/open-apis/search/v2/message', {
        params: {
          page_size: appliedPageSize,
          user_id_type: 'open_id',
          ...(page_token ? { page_token } : {}),
        },
        data: {
          query,
          ...(from_ids?.length ? { from_ids } : {}),
          ...(chat_ids?.length ? { chat_ids } : {}),
          ...(at_chatter_ids?.length ? { at_chatter_ids } : {}),
          ...(from_type ? { from_type } : {}),
          ...(chat_type ? { chat_type } : {}),
          ...(message_type ? { message_type } : {}),
        },
      });
      if (!search.ok) return formatToolResult(search);

      const sdata = search.data as
        | { items?: unknown[]; page_token?: string; has_more?: boolean }
        | undefined;
      const messageIds = (sdata?.items ?? []).filter(
        (x): x is string => typeof x === 'string',
      );

      const base: Record<string, unknown> = {
        query,
        count: messageIds.length,
        has_more: sdata?.has_more ?? false,
        ...(sdata?.has_more && sdata.page_token ? { page_token: sdata.page_token } : {}),
      };

      // Lightweight mode: hand back just the ids. (hydrate=true with an empty
      // result deliberately falls through to the hydrate block below so the
      // response shape stays consistent — hydrate=true always yields
      // messages/user_map, never message_ids, even when empty; PR #328 review.)
      if (!hydrate) {
        base.message_ids = messageIds;
        if (messageIds.length > 0) {
          base.hint =
            'hydrate=false 只返回 message_id 列表,适合只需要 id 的场景(计数/去重/传递);要读正文/发送者/附件请用默认 hydrate=true(im_read_messages 不接受裸 message_id)。';
        }
        return formatToolResult({ ok: true, data: base });
      }

      // Hydrate each hit into the same enriched shape im_read_messages returns:
      // fetch the message, collect sender / mention open_ids, then resolve all
      // open_ids → names in one batched pass and stamp sender_name on each.
      const messages: ImRawMessage[] = [];
      const openIds = new Set<string>();
      for (const mid of messageIds) {
        const r = await callFeishu((c, opts) =>
          c.im.message.get({ path: { message_id: mid } }, opts),
        );
        if (!r.ok) {
          messages.push({ message_id: mid, fetch_error: r.errorCode } as ImRawMessage);
          continue;
        }
        const item = ((r.data as { items?: ImRawMessage[] } | undefined)?.items ?? [])[0];
        if (!item) {
          messages.push({ message_id: mid } as ImRawMessage);
          continue;
        }
        if (item.sender?.id_type === 'open_id' && item.sender.id) {
          openIds.add(item.sender.id);
        }
        if (Array.isArray(item.mentions)) {
          for (const mention of item.mentions) {
            if (mention?.id_type === 'open_id' && mention.id) openIds.add(mention.id);
          }
        }
        messages.push(item);
      }

      const userMap = await resolveOpenIdsToNames(openIds);
      for (const m of messages) {
        const sid = m.sender?.id;
        if (sid && userMap.has(sid)) {
          (m.sender as Record<string, unknown>).sender_name = userMap.get(sid);
        }
      }
      const userMapObj: Record<string, string> = {};
      for (const [k, v] of userMap) userMapObj[k] = v;

      base.messages = messages;
      base.user_map = userMapObj;

      // Same guard im_read_messages applies: hydrating up to 20 full message
      // bodies (long text / post / file payloads) can exceed the MCP response
      // budget and bloat or break the turn. Truncate the serialized payload
      // past MAX_CONTENT_BYTES before returning (PR #328 review P2).
      const raw = JSON.stringify(base);
      if (Buffer.byteLength(raw, 'utf-8') > MAX_CONTENT_BYTES) {
        return { content: [{ type: 'text' as const, text: truncateContent(raw) }] };
      }
      return formatToolResult({ ok: true, data: base });
    },
  });
}

// 12.5 im_send_message
function registerImSendMessageTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'im_send_message',
    category: 'im',
    description: D.im_send_message,
    rules: ['mutation-confirm'],
    inputShape: {
      receive_id: z
        .string()
        .optional()
        .describe(
          '接收者 ID。新发消息必填;回复消息时传 message_id 即可。根据 receive_id_type 取值: open_id / chat_id / email / union_id / user_id / Receiver ID, type-specific.',
        ),
      receive_id_type: z
        .enum(['open_id', 'chat_id', 'email', 'union_id', 'user_id'])
        .default('open_id')
        .describe('接收者 ID 类型,默认 open_id / Receiver ID type, default open_id'),
      message_id: z
        .string()
        .regex(/^om_/, 'message_id must be a Feishu message id starting with om_')
        .optional()
        .describe(
          '要回复的飞书消息 ID,形如 om_xxx。传入后走回复接口,无需 receive_id / Target message id for reply mode.',
        ),
      content: z
        .string()
        .describe(
          'msg_type=text 时直接传文本(自动包装成 {"text":...});其他 msg_type 需传符合飞书规范的 JSON 字符串 / Plain text for msg_type=text (auto-wrapped); JSON string for other types.',
        ),
      msg_type: z
        .string()
        .default('text')
        .describe(
          '消息类型, 默认 text。常见: text / post / image / file / audio / media / sticker / interactive / share_chat / share_user.',
        ),
      reply_in_thread: z
        .boolean()
        .default(true)
        .describe(
          '仅回复模式生效,默认 true。群消息已有话题时进入该话题,未生成话题时由飞书基于目标消息创建/使用话题 / Reply in thread stream by default.',
        ),
      uuid: z
        .string()
        .optional()
        .describe(
          '幂等去重 key,1h 内同一 uuid 视为重发同一条消息,避免重复发送 / Idempotency key, dedup window is 1h.',
        ),
    },
    handler: async ({
      receive_id,
      receive_id_type,
      message_id,
      content,
      msg_type,
      reply_in_thread,
      uuid,
    }) => {
      if (!message_id && !receive_id) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGS',
          data: {
            message:
              '新发消息必须传 receive_id;回复消息必须传 message_id / Pass receive_id to send a new message, or message_id to reply.',
          },
        });
      }
      if (message_id && receive_id) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGS',
          data: {
            message:
              'receive_id 与 message_id 只能传一个。传 message_id 表示回复消息,传 receive_id 表示新发消息 / Pass either receive_id or message_id.',
          },
        });
      }

      const payloadContent = normalizeImMessageContent(msg_type, content);

      if (message_id) {
        const result = await callFeishu((c, opts) =>
          c.im.message.reply(
            {
              path: { message_id },
              data: {
                msg_type,
                content: payloadContent,
                reply_in_thread,
                ...(uuid ? { uuid } : {}),
              },
            },
            opts,
          ),
        );

        return formatToolResult(result);
      }

      const result = await callFeishu((c, opts) =>
        c.im.message.create(
          {
            data: {
              receive_id: receive_id!,
              msg_type,
              content: payloadContent,
              ...(uuid ? { uuid } : {}),
            },
            params: { receive_id_type },
          },
          opts,
        ),
      );

      return formatToolResult(result);
    },
  });
}

// 12.6 im_upload_image
function registerImUploadImageTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'im_upload_image',
    category: 'im',
    description: D.im_upload_image,
    inputShape: {
      file_path: z
        .string()
        .describe('本地图片绝对路径 / Absolute path to the local image file'),
      image_type: z
        .enum(['message', 'avatar'])
        .default('message')
        .describe('图片用途,默认 message(用于聊天发送);avatar 用于头像 / Image purpose, default message'),
    },
    handler: async ({ file_path, image_type }) => {
      const guarded = await resolveUploadAbsPath(file_path);
      if (!guarded.ok) return formatToolResult(guarded.result);
      const absPath = guarded.absPath;

      const result = await withAuthRetry(async (opts) => {
        const upload = await deps.uploadFeishuImage({
          client: getFeishuClient(),
          absPath,
          imageType: image_type,
          authOpts: opts,
        });
        if (upload.ok) {
          return { ok: true, data: { image_key: upload.imageKey } };
        }
        // 把共享 helper 的错误码映射回 MCP 工具的 errorCode + 中英双语 message,
        // 保持对外契约不变(老的 ai/agent 调用方还在按这些 errorCode 分支)。
        switch (upload.code) {
          case 'FILE_NOT_FOUND':
            return {
              ok: false,
              errorCode: 'FILE_NOT_FOUND',
              data: { file_path: upload.absPath, message: '文件不存在 / File does not exist' },
            };
          case 'INVALID_FILE':
            return {
              ok: false,
              errorCode: 'INVALID_FILE',
              data: { message: '不允许上传空文件 / Empty file not allowed' },
            };
          case 'FILE_TOO_LARGE':
            return {
              ok: false,
              errorCode: 'FILE_TOO_LARGE',
              data: {
                size: upload.size,
                limit: deps.feishuImageMaxBytes,
                message: '图片不得超过 10MB',
              },
            };
          case 'UPLOAD_FAILED':
          default:
            return {
              ok: false,
              errorCode: 'FEISHU_API_ERROR',
              data: { message: upload.message },
            };
        }
      });

      return formatToolResult(result);
    },
  });
}

// 12.7 im_upload_file
function registerImUploadFileTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'im_upload_file',
    category: 'im',
    description: D.im_upload_file,
    inputShape: {
      file_path: z
        .string()
        .describe('本地文件绝对路径 / Absolute path to the local file'),
      file_type: z
        .enum(['opus', 'mp4', 'pdf', 'doc', 'xls', 'ppt', 'stream'])
        .describe(
          '文件类型,飞书要求显式声明: opus=音频, mp4=视频, pdf/doc/xls/ppt=Office 文档, stream=其他任意二进制(如 zip/png 之外的图等). ' +
          'File type, must be declared.',
        ),
      file_name: z
        .string()
        .optional()
        .describe(
          '展示给接收方的文件名,不传则用本地文件名 / Display name shown to recipient, defaults to the local filename',
        ),
      duration: z
        .number()
        .optional()
        .describe(
          '音视频文件的时长(毫秒),仅 opus / mp4 类型有意义 / Duration in ms, only meaningful for opus / mp4',
        ),
    },
    handler: async ({ file_path, file_type, file_name, duration }) => {
      const guarded = await resolveUploadAbsPath(file_path);
      if (!guarded.ok) return formatToolResult(guarded.result);
      const absPath = guarded.absPath;
      if (!fs.existsSync(absPath)) {
        return formatToolResult({
          ok: false,
          errorCode: 'FILE_NOT_FOUND',
          data: { file_path: absPath, message: '文件不存在 / File does not exist' },
        });
      }

      const stat = fs.statSync(absPath);
      if (stat.size === 0) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_FILE',
          data: { message: '不允许上传空文件 / Empty file not allowed' },
        });
      }
      if (stat.size > 30 * 1024 * 1024) {
        return formatToolResult({
          ok: false,
          errorCode: 'FILE_TOO_LARGE',
          data: { size: stat.size, limit: 30 * 1024 * 1024, message: '文件不得超过 30MB' },
        });
      }

      const resolvedName = file_name && file_name.length > 0 ? file_name : path.basename(absPath);

      const result = await withAuthRetry((opts) => {
        const client = getFeishuClient();
        return safeCall(async () => {
          // Same wrapping reason as im_upload_image: SDK's file.create returns
          // `{ file_key } | null` directly without the standard envelope.
          const res = await client.im.file.create(
            {
              data: {
                file_type,
                file_name: resolvedName,
                file: fs.createReadStream(absPath),
                ...(duration !== undefined ? { duration } : {}),
              },
            },
            opts,
          );
          return { code: 0, data: res ?? {} };
        });
      });

      return formatToolResult(result);
    },
  });
}

// ── Contact tools ─────────────────────────────────────────────────────────

// 13. contact_search
function registerContactSearchTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'contact_search',
    category: 'contact',
    description: D.contact_search,
    inputShape: {
      query: z
        .string()
        .optional()
        .describe('按姓名模糊搜索的关键词;与 open_id 二选一 / Name keyword, mutually exclusive with open_id'),
      open_id: z
        .string()
        .optional()
        .describe('精确查询的用户 open_id;传了就走单查路径,忽略 query / Exact user open_id; if set, fetches that single user and ignores query'),
      page_size: z
        .number()
        .default(50)
        .describe('每页扫描数量,默认 50(仅用于姓名搜索)/ Scan page size, default 50 (only used for name search)'),
    },
    handler: async ({ query, open_id, page_size }) => {
      if (open_id) {
        const getResult = await callFeishu((c, opts) =>
          c.contact.user.get(
            {
              path: { user_id: open_id },
              params: { user_id_type: 'open_id' },
            },
            opts,
          ),
        );
        return formatToolResult(getResult);
      }

      if (!query) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGUMENT',
          data: { message: 'query 与 open_id 至少传一个 / provide either query or open_id' },
        });
      }

      const searchResult = await withAuthRetry((opts) => {
        const client = getFeishuClient();
        return safeCall(async () => {
          const res = await client.request<{ code: number; msg?: string; data?: unknown }>({
            method: 'POST',
            url: '/open-apis/search/v1/user',
            data: { query },
            params: { page_size, user_id_type: 'open_id' },
          }, opts);
          return res;
        });
      });

      if (searchResult.ok) return formatToolResult(searchResult);

      const fallbackResult = await withAuthRetry(async (opts) => {
        const client = getFeishuClient();
        const queryLower = query.toLowerCase();
        const matched: { name: string; open_id: string; email?: string }[] = [];
        let pageToken: string | undefined;

        while (matched.length < 10) {
          const listResult = await safeCall(() =>
            client.contact.user.list(
              {
                params: {
                  page_size,
                  user_id_type: 'open_id',
                  ...(pageToken ? { page_token: pageToken } : {}),
                },
              },
              opts,
            ),
          );

          if (!listResult.ok) return listResult;

          const data = listResult.data as {
            items?: { name?: string; open_id?: string; email?: string }[];
            has_more?: boolean;
            page_token?: string;
          } | undefined;

          if (data?.items) {
            for (const user of data.items) {
              const name = user.name || '';
              if (name.toLowerCase().includes(queryLower) || queryLower.includes(name.toLowerCase())) {
                matched.push({
                  name,
                  open_id: user.open_id || '',
                  email: user.email,
                });
              }
            }
          }

          if (data?.has_more && data.page_token) {
            pageToken = data.page_token;
          } else {
            break;
          }
        }

        return {
          ok: true as const,
          data: {
            users: matched,
            total_matched: matched.length,
            hint: matched.length === 0 ? '未找到匹配的用户,请提供邮箱 / No matching users found, please provide email' : undefined,
          },
        };
      });

      return formatToolResult(fallbackResult);
    },
  });
}

// 14. contact_get_user
function registerContactGetUserTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'contact_get_user',
    category: 'contact',
    description: D.contact_get_user,
    inputShape: {
      open_id: z.string().describe('用户 open_id / User open_id'),
      department_id_type: z
        .enum(['department_id', 'open_department_id'])
        .optional()
        .describe('返回部门 ID 的类型(可选)/ Returned department id type (optional)'),
    },
    handler: async ({ open_id, department_id_type }) => {
      const result = await callFeishu((c, opts) =>
        c.contact.user.get(
          {
            path: { user_id: open_id },
            params: {
              user_id_type: 'open_id',
              ...(department_id_type ? { department_id_type } : {}),
            },
          },
          opts,
        ),
      );
      return formatToolResult(result);
    },
  });
}

// 15. contact_batch_get_users
function registerContactBatchGetUsersTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'contact_batch_get_users',
    category: 'contact',
    description: D.contact_batch_get_users,
    inputShape: {
      open_ids: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe('用户 open_id 列表,1-50 个 / List of user open_ids, 1-50 items'),
      department_id_type: z
        .enum(['department_id', 'open_department_id'])
        .optional()
        .describe('返回部门 ID 的类型(可选)/ Returned department id type (optional)'),
    },
    handler: async ({ open_ids, department_id_type }) => {
      const result = await callFeishu((c, opts) =>
        c.contact.user.batch(
          {
            params: {
              user_ids: open_ids,
              user_id_type: 'open_id',
              ...(department_id_type ? { department_id_type } : {}),
            },
          },
          opts,
        ),
      );
      return formatToolResult(result);
    },
  });
}

// ── Calendar tools ────────────────────────────────────────────────────────

// 16. calendar_list_events
function registerCalendarListEventsTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'calendar_list_events',
    category: 'calendar',
    description: D.calendar_list_events,
    inputShape: {
      calendar_id: z
        .string()
        .default('primary')
        .describe('日历 ID,默认 "primary"(用户主日历)/ Calendar ID, default "primary"'),
      start_time: z
        .string()
        .describe('起始时间,支持 Unix 秒/毫秒时间戳或 RFC3339/ISO;无时区时按 time_zone 或运行环境本地时区解析 / Start time'),
      end_time: z
        .string()
        .describe('结束时间,同 start_time 格式 / End time'),
      time_zone: z
        .string()
        .optional()
        .describe('解析无时区日期时间时使用的时区,如 Asia/Shanghai、America/Los_Angeles 或 +08:00;不传则用运行环境本地时区 / Timezone for timezone-less date-times'),
      ...paginationInput(50),
    },
    handler: async ({ calendar_id, start_time, end_time, time_zone, page_size, page_token }) => {
      const startTs = parseFeishuTimestampSeconds(start_time, { timeZone: time_zone });
      if (!startTs.ok) {
        return formatInvalidTimeResult('start_time', start_time, startTs.error);
      }

      const endTs = parseFeishuTimestampSeconds(end_time, { timeZone: time_zone });
      if (!endTs.ok) {
        return formatInvalidTimeResult('end_time', end_time, endTs.error);
      }

      const result = await callFeishu((c, opts) =>
        c.calendar.calendarEvent.list(
          {
            path: { calendar_id },
            params: {
              start_time: startTs.value,
              end_time: endTs.value,
              page_size,
              ...(page_token ? { page_token } : {}),
            },
          },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      return formatToolResult({
        ok: true,
        data: shapePage(
          result.data as
            | { items?: unknown[]; has_more?: boolean; page_token?: string }
            | undefined,
          'events',
        ),
      });
    },
  });
}

// 17. calendar_get_event
function registerCalendarGetEventTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'calendar_get_event',
    category: 'calendar',
    description: D.calendar_get_event,
    inputShape: {
      calendar_id: z
        .string()
        .default('primary')
        .describe('日历 ID,默认 "primary" / Calendar ID, default "primary"'),
      event_id: z
        .string()
        .describe('日程 ID / Event ID'),
    },
    handler: async ({ calendar_id, event_id }) => {
      const result = await callFeishu((c, opts) =>
        c.calendar.calendarEvent.get(
          { path: { calendar_id, event_id } },
          opts,
        ),
      );
      return formatToolResult(result);
    },
  });
}

// 18. calendar_create_event
function registerCalendarCreateEventTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'calendar_create_event',
    category: 'calendar',
    description: D.calendar_create_event,
    rules: ['mutation-confirm'],
    inputShape: {
      summary: z.string().describe('日程标题 / Event title'),
      start_time: z
        .string()
        .describe('开始时间,支持 Unix 秒/毫秒时间戳或 RFC3339/ISO;无时区时按 time_zone 或运行环境本地时区解析 / Start time'),
      end_time: z
        .string()
        .describe('结束时间,同 start_time 格式 / End time'),
      time_zone: z
        .string()
        .optional()
        .describe('解析无时区日期时间时使用的时区,如 Asia/Shanghai、America/Los_Angeles 或 +08:00;不传则用运行环境本地时区 / Timezone for timezone-less date-times'),
      description: z
        .string()
        .optional()
        .describe('日程描述 / Event description'),
      attendee_open_ids: z
        .array(z.string())
        .optional()
        .describe('参与者 open_id 列表(通过 contact_search 搜人获取)/ Attendee open_id list from contact search'),
      attendee_emails: z
        .array(z.string())
        .optional()
        .describe('参与者邮箱列表(搜不到 open_id 时用邮箱兜底)/ Fallback attendee emails'),
      location: z
        .string()
        .optional()
        .describe('地点 / Location'),
      calendar_id: z
        .string()
        .default('primary')
        .describe('日历 ID,默认 "primary" / Calendar ID, default "primary"'),
    },
    handler: async ({ summary, start_time, end_time, time_zone, description, attendee_open_ids, attendee_emails, location, calendar_id }) => {
      const startTs = parseFeishuTimestampSeconds(start_time, { timeZone: time_zone });
      if (!startTs.ok) {
        return formatInvalidTimeResult('start_time', start_time, startTs.error);
      }

      const endTs = parseFeishuTimestampSeconds(end_time, { timeZone: time_zone });
      if (!endTs.ok) {
        return formatInvalidTimeResult('end_time', end_time, endTs.error);
      }

      const result = await callFeishu((c, opts) =>
        c.calendar.calendarEvent.create(
          {
            path: { calendar_id },
            data: {
              summary,
              start_time: { timestamp: startTs.value },
              end_time: { timestamp: endTs.value },
              need_notification: true,
              ...(description ? { description } : {}),
              ...(location ? { location: { name: location } } : {}),
            },
          },
          opts,
        ),
      );
      if (!result.ok) return formatToolResult(result);

      const attendees: { type: 'user' | 'third_party'; user_id?: string; third_party_email?: string }[] = [];
      if (attendee_open_ids) {
        attendees.push(...attendee_open_ids.map((id: string) => ({ type: 'user' as const, user_id: id })));
      }
      if (attendee_emails) {
        attendees.push(...attendee_emails.map((email: string) => ({ type: 'third_party' as const, third_party_email: email })));
      }

      if (attendees.length > 0) {
        const eventId = (result.data as { event?: { event_id?: string } })?.event?.event_id;
        if (eventId) {
          const attendeeResult = await callFeishu((c, opts) =>
            c.calendar.calendarEventAttendee.create(
              {
                path: { calendar_id, event_id: eventId },
                params: { user_id_type: 'open_id' },
                data: { attendees },
              },
              opts,
            ),
          );
          if (!attendeeResult.ok) {
            return formatToolResult({
              ok: true,
              data: {
                event: (result.data as Record<string, unknown>)?.event,
                attendee_warning: `日程已创建但添加参与者失败: ${attendeeResult.errorCode}`,
              },
            });
          }
        }
      }

      return formatToolResult(result);
    },
  });
}

// ── Minutes (妙记) 内部原语 ────────────────────────────────────────────────
//
// SDK 没有 typed module,走 client.request() 调;不再单独暴露为工具,
// 由 meeting_content 在"智能纪要 docx 没命中"时兜底复用:
//   - POST /open-apis/minutes/v1/minutes/search           (按 create_time 时间窗搜我能看到的妙记)
//   - GET  /open-apis/minutes/v1/minutes/{token}/artifacts (AI 总结/待办/章节)
// 都用 user_access_token 鉴权,需要 OAuth scope:
//   minutes:minutes.search:read 与 minutes:minutes.artifacts:read

interface MinutesSearchItem {
  token?: string;
  display_info?: string;
  meta_data?: {
    description?: string;
    app_link?: string;
    avatar?: string;
  };
  [k: string]: unknown;
}

// 妙记内部原语(供 meeting_content 复用,不再单独暴露为工具)。
// POST /open-apis/minutes/v1/minutes/search —— 在 create_time 时间窗内搜当前用户能看到的妙记。
interface MinutesHit {
  token: string;
  url: string;
  display_info: string;
  description: string;
}

async function minutesSearchByWindow(
  startRfc: string,
  endRfc: string,
  query: string | undefined,
  pageSize: number,
): Promise<{ ok: true; hits: MinutesHit[] } | { ok: false; error: FeishuApiResult }> {
  const body: Record<string, unknown> = {
    filter: { create_time: { start_time: startRfc, end_time: endRfc } },
  };
  if (query && query.trim()) body.query = query.trim();

  const result = await withAuthRetry((opts) => {
    const client = getFeishuClient();
    return safeCall(async () => {
      const res = await client.request<{ code: number; msg?: string; data?: unknown }>(
        {
          method: 'POST',
          url: '/open-apis/minutes/v1/minutes/search',
          data: body,
          params: { page_size: pageSize },
        },
        opts,
      );
      return res;
    });
  });
  if (!result.ok) return { ok: false, error: result };

  const data = result.data as { items?: MinutesSearchItem[] } | undefined;
  const hits: MinutesHit[] = (data?.items ?? []).map((item) => ({
    token: item.token ?? '',
    url: item.meta_data?.app_link ?? '',
    display_info: item.display_info ?? '',
    description: item.meta_data?.description ?? '',
  }));
  return { ok: true, hits };
}

// GET /open-apis/minutes/v1/minutes/{token}/artifacts —— 妙记 AI 产物(总结/待办/章节)。
async function minutesGetArtifacts(minuteToken: string): Promise<FeishuApiResult> {
  return withAuthRetry((opts) => {
    const client = getFeishuClient();
    return safeCall(async () => {
      const res = await client.request<{ code: number; msg?: string; data?: unknown }>(
        {
          method: 'GET',
          url: `/open-apis/minutes/v1/minutes/${encodeURIComponent(minuteToken)}/artifacts`,
        },
        opts,
      );
      return res;
    });
  });
}

// ── Docx editing tools ─────────────────────────────────────────────────────
//
// 写操作设计原则:
//   - 定位通过 wiki/docx URL 或裸 document_id;wiki 节点会被解析到 obj_token,
//     非 docx 类型(如 bitable)直接拒绝,避免误改表格。
//   - 调用前需先 docx_read 看清楚结构(根块的 block_id == document_id;
//     子块的 block_id 在 read 返回的 blocks 列表里),再下手写。
//   - 飞书会按当前登录用户的权限校验,无编辑权限会返回 FEISHU_API_ERROR。

/**
 * Map block_type → field name in Feishu block payload.
 * 仅覆盖纯文本类块,富文本场景请用 raw 自行构造。
 */
const DOCX_BLOCK_TYPE_FIELD: Record<number, string> = {
  2: 'text',
  3: 'heading1',
  4: 'heading2',
  5: 'heading3',
  6: 'heading4',
  7: 'heading5',
  8: 'heading6',
  9: 'heading7',
  10: 'heading8',
  11: 'heading9',
  12: 'bullet',
  13: 'ordered',
  14: 'code',
  15: 'quote',
  22: 'divider',
  27: 'image',
};

const DOCX_BLOCK_TYPE_DESC =
  '块类型: 2=文本段落, 3-11=H1~H9 标题, 12=无序列表项, 13=有序列表项, 14=代码块, 15=引用, 22=分割线, 27=图片(空壳,需后续 docx_upload_image 上传)';

interface DocxBlockSpec {
  block_type: number;
  text?: string;
  raw?: Record<string, unknown>;
}

/**
 * Build a single child block payload for documentBlockChildren.create.
 * Throws on unsupported block_type (caught by handler and returned as INVALID_ARGS).
 */
function buildDocxBlockChild(spec: DocxBlockSpec): Record<string, unknown> {
  if (spec.raw) {
    return { block_type: spec.block_type, ...spec.raw };
  }
  if (spec.block_type === 22) {
    return { block_type: 22, divider: {} };
  }
  if (spec.block_type === 27) {
    // Image block: created as an empty shell. The actual image is bound later
    // via drive.media.uploadAll using parent_type=docx_image, parent_node=<this block_id>.
    return { block_type: 27, image: {} };
  }
  const fieldName = DOCX_BLOCK_TYPE_FIELD[spec.block_type];
  if (!fieldName) {
    throw new Error(
      `Unsupported block_type: ${spec.block_type}. ${DOCX_BLOCK_TYPE_DESC};富文本/特殊块请用 raw 字段透传完整 JSON。`,
    );
  }
  return {
    block_type: spec.block_type,
    [fieldName]: {
      elements: [{ text_run: { content: spec.text ?? '' } }],
      style: {},
    },
  };
}

/**
 * Resolve a Feishu URL or token to a docx document_id.
 *
 * - wiki URL: 解析到 obj_token,且 obj_type 必须是 docx
 * - docx/docs URL: 直接抽 token
 * - 裸字符串: 当 document_id 用
 */
async function resolveSheetSpreadsheetToken(
  urlOrToken: string,
): Promise<
  | {
      spreadsheetToken: string;
      sheetHint?: string;
      tableHint?: string;
      viewHint?: string;
    }
  | { error: FeishuApiResult }
> {
  // Feishu sheet URLs encode the active tab as `?sheet=<sheet_id>`; carry it
  // through so readers can default to the tab the user actually opened instead
  // of always falling back to the first tab.
  const sheetHint = urlOrToken.match(/[?&]sheet=([A-Za-z0-9]+)/)?.[1];
  const tableHint = urlOrToken.match(/[?&]table=([A-Za-z0-9]+)/)?.[1];
  const viewHint = urlOrToken.match(/[?&]view=([A-Za-z0-9]+)/)?.[1];

  const wikiMatch = urlOrToken.match(/feishu\.cn\/wiki\/(\w+)/);
  if (wikiMatch) {
    const nodeToken = wikiMatch[1];
    const nodeResult = await callFeishu((c, opts) =>
      c.wiki.space.getNode({ params: { token: nodeToken } }, opts),
    );
    if (!nodeResult.ok) return { error: nodeResult };
    const node = (nodeResult.data as {
      node?: { obj_token?: string; obj_type?: string };
    } | undefined)?.node;
    if (!node?.obj_token) {
      return { error: { ok: false, errorCode: 'NOT_FOUND' } };
    }
    if (node.obj_type !== 'sheet') {
      return {
        error: {
          ok: false,
          errorCode: 'NOT_A_SHEET',
          data: {
            obj_type: node.obj_type,
            hint: 'sheet 工具只支持飞书电子表格;docx/bitable 等其他类型请用对应工具',
          },
        },
      };
    }
    return { spreadsheetToken: node.obj_token, sheetHint, tableHint, viewHint };
  }

  const sheetMatch = urlOrToken.match(/feishu\.cn\/sheets\/([A-Za-z0-9]+)/);
  if (sheetMatch) {
    return { spreadsheetToken: sheetMatch[1], sheetHint, tableHint, viewHint };
  }

  if (/^[A-Za-z0-9]+$/.test(urlOrToken)) return { spreadsheetToken: urlOrToken };

  return {
    error: {
      ok: false,
      errorCode: 'UNSUPPORTED_URL',
      data: {
        input: urlOrToken,
        hint: '仅支持 feishu.cn/sheets/* / wiki/* URL,或裸 spreadsheet_token',
      },
    },
  };
}

// ── Meeting content(统一会议内容入口)───────────────────────────────────
//
// 一场飞书会的内容有两种存储形态,可见性不同:
//   1. 智能纪要 docx:飞书自动生成、分发给全体参会人(总结/待办/章节俱全),人人可读;
//   2. 妙记对象:只在"你自己妙记列表"里可见(minutesSearchByWindow 走的就是它)。
// 大型例会典型是"妙记归组织者、纪要 docx 发全员",于是只搜妙记会假阴性。
// meeting_content 按"会议名+日期"确定性地取内容,内部按序兜底,把假阴性焊死在代码层。

/**
 * 按会议名 + 日期定位智能纪要 docx。两段式搜 docx(会议名+中文完整日期 强信号 /
 * 仅会议名 宽召回)+ 代码侧严格校验标题日期(pickMatchingNotes),避免误命中同系列别的日期。
 */
async function findNotesDocs(
  meetingName: string,
  target: TargetDate,
): Promise<{ ok: true; matches: NotesCandidate[] } | { ok: false; error: FeishuApiResult }> {
  const queries = [buildNotesQuery(meetingName, target), `智能纪要 ${meetingName.trim()}`];
  const candMap = new Map<string, NotesCandidate>();
  let lastError: FeishuApiResult | null = null;

  for (const q of queries) {
    const res = await searchDocs(q, [DOCX_SEARCH_TYPE], 20);
    if (!res.ok) {
      lastError = res;
      continue;
    }
    const entities =
      (res.data as { docs_entities?: SearchResultItem[] } | undefined)?.docs_entities ?? [];
    for (const e of entities) {
      if (e.docs_token && !candMap.has(e.docs_token)) {
        candMap.set(e.docs_token, { title: e.title ?? '', token: e.docs_token, url: e.url ?? '' });
      }
    }
    // 强 query 已命中确切日期就不必再宽搜。
    if (pickMatchingNotes([...candMap.values()], meetingName, target).length > 0) break;
  }

  const candidates = [...candMap.values()];
  if (candidates.length === 0 && lastError) return { ok: false, error: lastError };
  return { ok: true, matches: pickMatchingNotes(candidates, meetingName, target) };
}

/** Unix 秒 → 指定时区下的可读 'YYYY-MM-DD HH:mm'。 */
function formatSecondsInZone(seconds: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(seconds * 1000));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

/**
 * 用 calendarEvent.instanceView 展开某日历在 [startSec, endSec] 的所有实例。
 * 与 calendar_list_events(底层 calendarEvent.list,对重复日程只返回母事件、其 start_time
 * 是系列首次时间)不同:instanceView 按重复规则**展开实例**,当天的每周例会会作为「当天
 * 实例」返回,日期/时间准确——这是 meeting_content「按天不漏」的基石。窗口须 < 40 天
 * (本工具固定单日,天然满足),该接口不分页。
 */
async function instanceViewDay(
  calendarId: string,
  startSec: string,
  endSec: string,
): Promise<{ ok: true; items: RawCalendarInstance[] } | { ok: false; error: FeishuApiResult }> {
  const result = await callFeishu((c, opts) =>
    c.calendar.calendarEvent.instanceView(
      { path: { calendar_id: calendarId }, params: { start_time: startSec, end_time: endSec } },
      opts,
    ),
  );
  if (!result.ok) return { ok: false, error: result };
  const rawItems =
    (
      result.data as
        | {
            items?: Array<{
              summary?: string;
              status?: string;
              start_time?: { timestamp?: string; date?: string };
              end_time?: { timestamp?: string };
              attendee_ability?: string;
              event_organizer?: { user_id?: string; display_name?: string };
              vchat?: { meeting_url?: string };
            }>;
          }
        | undefined
    )?.items ?? [];
  const items: RawCalendarInstance[] = rawItems.map((it) => ({
    summary: it.summary,
    status: it.status,
    startTimestamp: it.start_time?.timestamp,
    startDate: it.start_time?.date,
    endTimestamp: it.end_time?.timestamp,
    attendeeAbility: it.attendee_ability,
    organizerUserId: it.event_organizer?.user_id,
    organizerDisplayName: it.event_organizer?.display_name,
    vchatUrl: it.vchat?.meeting_url,
  }));
  return { ok: true, items };
}

/** 限并发度跑 async 映射(单日会议量级小,默认 3 路兼顾速度与避免触发飞书限流)。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

/** meeting_content「按天」模式下,每场会一行的结构。 */
interface MeetingEventRow {
  summary: string;
  start_time: string;
  end_time: string | null;
  organizer: string | null;
  is_self_organizer: boolean;
  source: 'notes_doc' | 'minutes' | 'none';
  status: MeetingContentStatus;
  doc_url?: string;
  doc_token?: string;
  minute_url?: string;
  minute_token?: string;
  reason?: string;
}

/** 把每场会的 status 计成一句中文概览,让 agent 一眼看清覆盖率(谁没拿到、为什么)。 */
function buildSummaryLine(date: string, events: MeetingEventRow[]): string {
  const n = events.length;
  if (n === 0) return `${date} 当天没有会议(或你无访问权)。`;
  const got = events.filter(
    (e) => e.status === 'got_notes_doc' || e.status === 'got_minutes',
  ).length;
  const missNotOrg = events.filter((e) => e.status === 'missing_not_organizer').length;
  const missNoRec = events.filter((e) => e.status === 'missing_no_record').length;
  const parts: string[] = [`${got} 场拿到纪要`];
  if (missNotOrg) parts.push(`${missNotOrg} 场因非组织者拿不到妙记`);
  if (missNoRec) parts.push(`${missNoRec} 场未开妙记/未生成纪要`);
  return `${date} 共 ${n} 场会:${parts.join(',')}。`;
}

// ── VC meeting_list helper(VC 系统作为主数据源)────────────────────────────────

/**
 * 调用 VC meeting_list API 列出指定时间段内实际发生的所有会议。
 * 自动分页;权限不足时 graceful 降级返回 { ok: false }。
 */
async function vcMeetingListDay(
  startSec: string,
  endSec: string,
): Promise<{ ok: true; meetings: VcMeetingRecord[] } | { ok: false }> {
  const all: VcMeetingRecord[] = [];
  let pageToken: string | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const params: Record<string, unknown> = {
      start_time: startSec,
      end_time: endSec,
      meeting_status: 2, // ended
      page_size: 50,
    };
    if (pageToken) params.page_token = pageToken;

    const result = await callOpenApi('GET', '/open-apis/vc/v1/meeting_list', { params });
    if (!result.ok) return { ok: false };

    const data = result.data as
      | {
          meeting_list?: Array<{
            meeting_id?: string;
            meeting_topic?: string;
            meeting_start_time?: string;
            meeting_end_time?: string;
            ai_note?: boolean;
            has_related_document?: boolean;
            organizer?: string;
          }>;
          has_more?: boolean;
          page_token?: string;
        }
      | undefined;

    for (const item of data?.meeting_list ?? []) {
      if (!item.meeting_id) continue;
      const start = item.meeting_start_time ? parseVcMeetingTime(item.meeting_start_time) : null;
      const end = item.meeting_end_time ? parseVcMeetingTime(item.meeting_end_time) : null;
      if (start == null) continue;
      all.push({
        meetingId: item.meeting_id,
        topic: item.meeting_topic ?? '',
        startSeconds: start,
        endSeconds: end ?? start,
        hasAiNote: item.ai_note ?? false,
        hasRelatedDocument: item.has_related_document ?? false,
        organizer: item.organizer ?? null,
      });
    }

    if (data?.has_more && data.page_token) {
      pageToken = data.page_token;
    } else {
      break;
    }
  }

  return { ok: true, meetings: all.sort((a, b) => a.startSeconds - b.startSeconds) };
}

/**
 * 通过 VC recording API 获取会议的 minutes_token。
 * recording.url 格式: https://meetings.feishu.cn/minutes/<token>
 */
async function vcGetRecordingMinutesToken(meetingId: string): Promise<string | null> {
  const result = await callOpenApi(
    'GET',
    `/open-apis/vc/v1/meetings/${encodeURIComponent(meetingId)}/recording`,
    {},
  );
  if (!result.ok) return null;
  const data = result.data as { recording?: { url?: string } } | undefined;
  const url = data?.recording?.url;
  if (!url) return null;
  return parseMinutesTokenFromUrl(url);
}

// ── Meeting content(按天枚举 + 逐场内容,统一入口)─────────────────────────────
//
// VC meeting_list 作为主数据源(枚举实际发生的会议,不丢不漏);
// 权限不可用时自动降级到日历 instanceView 模式。
//   - 不传 meeting_name → 当天全部会的清单 + 每场状态;
//   - 传 meeting_name   → 只看当天匹配那(几)场;命中唯一一场且需要正文时,
//                          直接返回该场完整纪要(等于旧的「按会议名取单场」体验)。
// 内容拿不到时(妙记归组织者、非组织者无权)显式标 reason,而不是装作没这场会。
function registerMeetingContentTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'meeting_content',
    category: 'minutes',
    description: D.meeting_content,
    rules: ['read'],
    inputShape: {
      date: z
        .string()
        .describe('日期 YYYY-MM-DD(也接受 2026/6/18、2026年6月18日)。取这一天的会 / Date'),
      meeting_name: z
        .string()
        .min(1)
        .optional()
        .describe(
          '可选,会议标题关键词(如「小镇周会」),与纪要/日程标题双向子串匹配。不传=当天所有会;传=只看匹配的那(几)场 / Optional meeting title filter',
        ),
      time_zone: z
        .string()
        .optional()
        .describe('解析日期与搜索用的时区,默认 Asia/Shanghai / Timezone'),
      calendar_id: z
        .string()
        .default('primary')
        .describe('日历 ID,默认 "primary"(本人主日历)/ Calendar ID'),
      include_content: z
        .boolean()
        .optional()
        .describe(
          '是否读出正文。默认:传了 meeting_name 时读(给全文)、不传时只给清单+链接。设 false 强制只清单,true 强制读 / Whether to read full content',
        ),
    },
    handler: async ({ date, meeting_name, time_zone, calendar_id, include_content }) => {
      const target = parseTargetDate(date);
      if (!target) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGUMENT',
          data: { message: `date 需为 YYYY-MM-DD,收到:${date}` },
        });
      }

      const tz = time_zone && time_zone.trim() ? time_zone : 'Asia/Shanghai';
      const startTs = parseFeishuTimestampSeconds(`${date} 00:00:00`, { timeZone: tz });
      if (!startTs.ok) return formatInvalidTimeResult('date', date, startTs.error);
      const endTs = parseFeishuTimestampSeconds(`${date} 23:59:59`, { timeZone: tz });
      if (!endTs.ok) return formatInvalidTimeResult('date', date, endTs.error);

      // ① 主路径:VC meeting_list 枚举当天实际发生的会议（不丢不漏）。
      //    权限不可用时降级到日历 instanceView。
      const vcResult = await vcMeetingListDay(startTs.value, endTs.value);
      const useVcPath = vcResult.ok && vcResult.meetings.length > 0;

      // ─── VC 主路径 ───────────────────────────────────────────────────────────
      if (useVcPath) {
        const allVcMeetings = vcResult.meetings;

        // ② 可选会议名过滤
        const nameFilter = meeting_name?.trim();
        let meetings = allVcMeetings;
        if (nameFilter) {
          meetings = allVcMeetings.filter((m) => nameMatches(m.topic, nameFilter));
          if (meetings.length === 0) {
            return formatToolResult({
              ok: true,
              data: {
                date,
                time_zone: tz,
                calendar_id,
                events: [],
                summary_line: allVcMeetings.length
                  ? `${date} 没有名称匹配「${nameFilter}」的会。当天的会有:${allVcMeetings
                      .map((m) => m.topic || '(无主题)')
                      .join('、')}。换个会议名,或不传 meeting_name 看全部。`
                  : `${date} 当天没有任何会议(或你无访问权)。`,
              },
            });
          }
        }

        // ③ 逐场(并发 3)定位内容
        const norm = (s: string) => s.replace(/\s+/g, '');
        const instanceDate = (startSeconds: number): TargetDate => {
          const ymd = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(new Date(startSeconds * 1000));
          return parseTargetDate(ymd) ?? target;
        };

        const events = await mapWithConcurrency<VcMeetingRecord, MeetingEventRow>(
          meetings,
          3,
          async (m) => {
            const base = {
              summary: m.topic || '(无主题)',
              start_time: formatSecondsInZone(m.startSeconds, tz),
              end_time: formatSecondsInZone(m.endSeconds, tz),
              organizer: m.organizer,
              is_self_organizer: false,
            };

            // 快捷路径:VC 标记有 AI 纪要 → 直接通过 recording URL 拿 minutes_token
            if (m.hasAiNote || m.hasRelatedDocument) {
              const minutesToken = await vcGetRecordingMinutesToken(m.meetingId);
              if (minutesToken) {
                return {
                  ...base,
                  source: 'minutes' as const,
                  status: 'got_minutes' as MeetingContentStatus,
                  minute_url: `${FEISHU_MINUTES_LINK_BASE}/minutes/${minutesToken}`,
                  minute_token: minutesToken,
                };
              }
            }

            // 路A:智能纪要 docx
            const found = await findNotesDocs(m.topic, instanceDate(m.startSeconds));
            if (found.ok && found.matches.length > 0) {
              const doc = found.matches[0];
              return {
                ...base,
                source: 'notes_doc' as const,
                status: 'got_notes_doc' as MeetingContentStatus,
                doc_url: doc.url,
                doc_token: doc.token,
              };
            }

            // 路B:妙记搜索(用 VC 的实际时间 ±15分钟容差)
            const BUFFER = 15 * 60;
            const startRfc = new Date((m.startSeconds - BUFFER) * 1000).toISOString();
            const endRfc = new Date((m.endSeconds + BUFFER) * 1000).toISOString();
            const ms = await minutesSearchByWindow(startRfc, endRfc, m.topic, 20);
            if (ms.ok && ms.hits.length > 0) {
              const wanted = norm(m.topic);
              const best =
                ms.hits.find((h) => norm(h.display_info).includes(wanted)) ?? ms.hits[0];
              if (best.token) {
                return {
                  ...base,
                  source: 'minutes' as const,
                  status: 'got_minutes' as MeetingContentStatus,
                  minute_url: best.url,
                  minute_token: best.token,
                };
              }
            }

            // 兜底
            return {
              ...base,
              source: 'none' as const,
              status: 'missing_no_record' as MeetingContentStatus,
              reason: '该会议已确认参加,但未找到可访问的妙记或智能纪要。可能未开启妙记录制。',
            };
          },
        );

        // ④ 命中唯一一场且需要正文
        const wantContent = include_content ?? Boolean(nameFilter);
        if (events.length === 1 && wantContent) {
          const e = events[0];
          if (e.source === 'notes_doc' && e.doc_token) {
            return readDocWithImageManifest(e.doc_token, 0, e.doc_url);
          }
          if (e.source === 'minutes' && e.minute_token) {
            const art = await minutesGetArtifacts(e.minute_token);
            if (art.ok) {
              const d = art.data as
                | { summary?: string; minute_todos?: unknown[]; minute_chapters?: unknown[] }
                | undefined;
              const summary = typeof d?.summary === 'string' ? d.summary : '';
              return formatToolResult({
                ok: true,
                data: {
                  source: 'minutes',
                  meeting_name: e.summary,
                  date,
                  minute_url: e.minute_url,
                  minute_token: e.minute_token,
                  summary,
                  todos: Array.isArray(d?.minute_todos) ? d.minute_todos : [],
                  chapters: Array.isArray(d?.minute_chapters) ? d.minute_chapters : [],
                  ...(summary
                    ? {}
                    : {
                        hint: '该妙记暂无 AI 总结(可能尚未生成、被关闭、或无 minutes:minutes.artifacts:read 权限)。',
                      }),
                },
              });
            }
          }
        }

        // ⑤ 清单返回
        return formatToolResult({
          ok: true,
          data: {
            date,
            time_zone: tz,
            calendar_id,
            events,
            summary_line: buildSummaryLine(date, events),
          },
        });
      }

      // ─── 日历降级路径(VC 不可用时)────────────────────────────────────────────
      const view = await instanceViewDay(calendar_id, startTs.value, endTs.value);
      if (!view.ok) return formatToolResult(view.error);

      const allMeetings = pickDayMeetingInstances(view.items);

      const nameFilter = meeting_name?.trim();
      let meetings = allMeetings;
      if (nameFilter) {
        meetings = allMeetings.filter((m) => nameMatches(m.summary, nameFilter));
        if (meetings.length === 0) {
          return formatToolResult({
            ok: true,
            data: {
              date,
              time_zone: tz,
              calendar_id,
              events: [],
              summary_line: allMeetings.length
                ? `${date} 没有名称匹配「${nameFilter}」的会。当天的会有:${allMeetings
                    .map((m) => m.summary)
                    .join('、')}。换个会议名,或不传 meeting_name 看全部。`
                : `${date} 当天没有任何会议(或你无访问权)。`,
            },
          });
        }
      }

      const norm = (s: string) => s.replace(/\s+/g, '');
      const instanceDate = (startSeconds: number): TargetDate => {
        const ymd = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(startSeconds * 1000));
        return parseTargetDate(ymd) ?? target;
      };

      const events = await mapWithConcurrency<DayMeetingInstance, MeetingEventRow>(
        meetings,
        3,
        async (m) => {
          const base = {
            summary: m.summary,
            start_time: formatSecondsInZone(m.startSeconds, tz),
            end_time: m.endSeconds != null ? formatSecondsInZone(m.endSeconds, tz) : null,
            organizer: m.organizerDisplayName,
            is_self_organizer: isSelfOrganizerHeuristic(m.attendeeAbility),
          };

          // 路A:智能纪要 docx
          const found = await findNotesDocs(m.summary, instanceDate(m.startSeconds));
          if (found.ok && found.matches.length > 0) {
            const doc = found.matches[0];
            return {
              ...base,
              source: 'notes_doc',
              status: 'got_notes_doc',
              doc_url: doc.url,
              doc_token: doc.token,
            };
          }

          // 路B:妙记搜索 — ±15分钟容差(修复:录制时间与日历不完全匹配)
          const BUFFER = 15 * 60;
          const startRfc = new Date((m.startSeconds - BUFFER) * 1000).toISOString();
          const endRfc = new Date(
            ((m.endSeconds ?? m.startSeconds + 3600) + BUFFER) * 1000,
          ).toISOString();
          const ms = await minutesSearchByWindow(startRfc, endRfc, m.summary, 20);
          if (ms.ok && ms.hits.length > 0) {
            const wanted = norm(m.summary);
            const best = ms.hits.find((h) => norm(h.display_info).includes(wanted)) ?? ms.hits[0];
            if (best.token) {
              return {
                ...base,
                source: 'minutes',
                status: 'got_minutes',
                minute_url: best.url,
                minute_token: best.token,
              };
            }
          }

          const status = classifyMeetingContentStatus({
            docHit: false,
            minutesHit: false,
            isSelfOrganizer: base.is_self_organizer,
          });
          const reason =
            status === 'missing_not_organizer'
              ? `你不是这场会的组织者${
                  m.organizerDisplayName ? `(组织者:${m.organizerDisplayName})` : ''
                },妙记在组织者名下,飞书限制无法读取。可让组织者开启「自动生成会议纪要并发送给全体参会人」,或把纪要 docx 链接发你用 read_by_url 读。`
              : '这场会你可管理但没找到纪要,大概率没开妙记/未生成智能纪要。';
          return { ...base, source: 'none', status, reason };
        },
      );

      // ④ 命中唯一一场且需要正文
      const wantContent = include_content ?? Boolean(nameFilter);
      if (events.length === 1 && wantContent) {
        const e = events[0];
        if (e.source === 'notes_doc' && e.doc_token) {
          return readDocWithImageManifest(e.doc_token, 0, e.doc_url);
        }
        if (e.source === 'minutes' && e.minute_token) {
          const art = await minutesGetArtifacts(e.minute_token);
          if (art.ok) {
            const d = art.data as
              | { summary?: string; minute_todos?: unknown[]; minute_chapters?: unknown[] }
              | undefined;
            const summary = typeof d?.summary === 'string' ? d.summary : '';
            return formatToolResult({
              ok: true,
              data: {
                source: 'minutes',
                meeting_name: e.summary,
                date,
                minute_url: e.minute_url,
                minute_token: e.minute_token,
                summary,
                todos: Array.isArray(d?.minute_todos) ? d.minute_todos : [],
                chapters: Array.isArray(d?.minute_chapters) ? d.minute_chapters : [],
                ...(summary
                  ? {}
                  : {
                      hint: '该妙记暂无 AI 总结(可能尚未生成、被关闭、或无 minutes:minutes.artifacts:read 权限)。',
                    }),
              },
            });
          }
        }
      }

      // ⑤ 清单返回
      return formatToolResult({
        ok: true,
        data: {
          date,
          time_zone: tz,
          calendar_id,
          events,
          summary_line: buildSummaryLine(date, events),
        },
      });
    },
  });
}

const SHEET_TARGET_DESC =
  '电子表格定位:飞书 sheets URL、wiki sheet URL 或裸 spreadsheet_token。wiki 节点会自动解析到 obj_token(非 sheet 类型会拒绝)';
const SHEET_CELL_VALUE = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const SHEET_VALUES = z.array(z.array(SHEET_CELL_VALUE)).min(1);

function registerSheetListSheetsTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'sheet_list_sheets',
    category: 'sheet',
    description: D.sheet_list_sheets,
    rules: ['read'],
    inputShape: {
      spreadsheet: z.string().describe(SHEET_TARGET_DESC),
    },
    handler: async ({ spreadsheet }) => {
      const resolved = await resolveSheetSpreadsheetToken(spreadsheet);
      if ('error' in resolved) return formatToolResult(resolved.error);
      const result = await getAllSheetsMeta(resolved.spreadsheetToken);
      if (!result.ok) return formatToolResult(result);
      const allSheets = result.data as FirstSheetMeta[];
      let bitableRefs = new Map<string, EmbeddedBitableRef>();
      if (allSheets.some((sheet) => sheet.resource_type === 'bitable')) {
        // Best-effort enrichment: the v3 listing above is already complete, so
        // a legacy v2 metainfo failure must not sink the whole listing — the
        // bitable tab just comes back without app_token/table_id, and the
        // actual read path surfaces the v2 error where it matters.
        const v2Result = await getSheetV2BlockMeta(resolved.spreadsheetToken);
        bitableRefs = new Map(
          (v2Result.ok ? (v2Result.data as SheetV2BlockMeta[]) : []).flatMap((sheet) => {
            const sheetId =
              sheet.sheetId ??
              sheet.sheet_id ??
              sheet.properties?.sheetId ??
              sheet.properties?.sheet_id;
            const ref = parseEmbeddedBitableRef(
              sheet,
              sheetId === resolved.sheetHint ? resolved.tableHint : undefined,
            );
            return sheetId && ref ? [[sheetId, ref] as const] : [];
          }),
        );
      }
      const sheets = allSheets.map((sheet) => ({
        sheet_id: sheet.sheet_id,
        title: sheet.title,
        index: sheet.index,
        hidden: sheet.hidden ?? false,
        row_count: sheet.grid_properties?.row_count ?? 0,
        column_count: sheet.grid_properties?.column_count ?? 0,
        ...(sheet.resource_type ? { resource_type: sheet.resource_type } : {}),
        ...(bitableRefs.get(sheet.sheet_id) ?? {}),
      }));
      return formatToolResult({
        ok: true,
        data: {
          spreadsheet_token: resolved.spreadsheetToken,
          sheet_count: sheets.length,
          sheets,
          url: sheetUrl(resolved.spreadsheetToken),
        },
      });
    },
  });
}

function registerSheetReadRangeTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'sheet_read_range',
    category: 'sheet',
    description: D.sheet_read_range,
    rules: ['read'],
    inputShape: {
      spreadsheet: z.string().describe(SHEET_TARGET_DESC),
      range: z
        .string()
        .optional()
        .describe(
          'A1 范围,如 A1:D20 或 Sheet1!A1:D20。不传默认按目标 sheet 的真实 grid 尺寸(grid_properties.row_count × column_count)精确读取。',
        ),
      sheet: z
        .string()
        .optional()
        .describe(
          '指定要读的页签:sheet_id 或页签标题(title)。不传读第一个页签;读多页签电子表格后面的页签时必须传(可先用 sheet_list_sheets 拿到 sheet_id)。当 range 已自带 "!" 前缀时本参数忽略。',
        ),
    },
    handler: async ({ spreadsheet, range, sheet }) => {
      const resolved = await resolveSheetSpreadsheetToken(spreadsheet);
      if ('error' in resolved) return formatToolResult(resolved.error);
      // Explicit `sheet` arg wins; otherwise fall back to the `?sheet=` tab the
      // user had open in the pasted URL.
      const sheetSelector = sheet ?? resolved.sheetHint;
      // Table/view hints are forwarded together with the URL's own tab id;
      // readSheetRange applies them only when the resolved target tab matches
      // that id (so an explicit `sheet` override of another tab drops them,
      // while naming the same tab by title keeps them).
      return formatToolResult(
        await readSheetRange(
          resolved.spreadsheetToken,
          range,
          sheetSelector,
          resolved.tableHint,
          resolved.viewHint,
          resolved.sheetHint,
        ),
      );
    },
  });
}

function registerSheetWriteRangeTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'sheet_write_range',
    category: 'sheet',
    description: D.sheet_write_range,
    rules: ['sheet-edit', 'mutation-confirm'],
    inputShape: {
      spreadsheet: z.string().describe(SHEET_TARGET_DESC),
      range: z.string().min(1).describe('目标 A1 范围,如 Sheet1!A2:C4'),
      values: SHEET_VALUES.describe('二维数组,按行写入目标 range'),
    },
    handler: async ({ spreadsheet, range, values }) => {
      const resolved = await resolveSheetSpreadsheetToken(spreadsheet);
      if ('error' in resolved) return formatToolResult(resolved.error);
      const result = await callSheetV2(
        'PUT',
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(resolved.spreadsheetToken)}/values`,
        { data: { valueRange: { range, values } } },
      );
      if (!result.ok) return formatToolResult(result);
      return formatToolResult({
        ok: true,
        data: {
          ...(result.data as Record<string, unknown> | undefined),
          spreadsheet_token: resolved.spreadsheetToken,
          range,
          row_count: values.length,
          column_count: values.reduce((max, row) => Math.max(max, row.length), 0),
          url: sheetUrl(resolved.spreadsheetToken),
        },
      });
    },
  });
}

function registerSheetAppendRowsTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'sheet_append_rows',
    category: 'sheet',
    description: D.sheet_append_rows,
    rules: ['sheet-edit', 'mutation-confirm'],
    inputShape: {
      spreadsheet: z.string().describe(SHEET_TARGET_DESC),
      range: z.string().min(1).describe('追加锚点范围,如 Sheet1!A1'),
      values: SHEET_VALUES.max(5000).describe('要追加的二维数组,单次最多 5000 行'),
    },
    handler: async ({ spreadsheet, range, values }) => {
      const resolved = await resolveSheetSpreadsheetToken(spreadsheet);
      if ('error' in resolved) return formatToolResult(resolved.error);
      const result = await callSheetV2(
        'POST',
        `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(resolved.spreadsheetToken)}/values_append`,
        { data: { valueRange: { range, values } } },
      );
      if (!result.ok) return formatToolResult(result);
      return formatToolResult({
        ok: true,
        data: {
          ...(result.data as Record<string, unknown> | undefined),
          spreadsheet_token: resolved.spreadsheetToken,
          range,
          appended_rows: values.length,
          column_count: values.reduce((max, row) => Math.max(max, row.length), 0),
          url: sheetUrl(resolved.spreadsheetToken),
        },
      });
    },
  });
}

async function resolveDocxDocumentId(
  urlOrId: string,
): Promise<{ documentId: string } | { error: FeishuApiResult }> {
  const wikiMatch = urlOrId.match(/feishu\.cn\/wiki\/(\w+)/);
  if (wikiMatch) {
    const nodeToken = wikiMatch[1];
    const nodeResult = await callFeishu((c, opts) =>
      c.wiki.space.getNode({ params: { token: nodeToken } }, opts),
    );
    if (!nodeResult.ok) return { error: nodeResult };
    const node = (nodeResult.data as {
      node?: { obj_token?: string; obj_type?: string };
    } | undefined)?.node;
    if (!node?.obj_token) {
      return { error: { ok: false, errorCode: 'NOT_FOUND' } };
    }
    if (node.obj_type !== 'docx') {
      return {
        error: {
          ok: false,
          errorCode: 'NOT_A_DOCX',
          data: {
            obj_type: node.obj_type,
            hint: '编辑工具只支持 docx 类型节点;bitable 等其他类型请用对应工具',
          },
        },
      };
    }
    return { documentId: node.obj_token };
  }

  const docxMatch = urlOrId.match(/feishu\.cn\/(?:docx|docs)\/(\w+)/);
  if (docxMatch) return { documentId: docxMatch[1] };

  if (/^[A-Za-z0-9]+$/.test(urlOrId)) return { documentId: urlOrId };

  return {
    error: {
      ok: false,
      errorCode: 'UNSUPPORTED_URL',
      data: {
        input: urlOrId,
        hint: '仅支持 feishu.cn/wiki/* / docx/* / docs/* URL,或裸 document_id',
      },
    },
  };
}

// 共享 zod 描述,4 个写工具复用
const DOCX_EDIT_URL_DESC =
  '文档定位:飞书 wiki/docx URL 或裸 document_id。wiki 节点会自动解析到 obj_token(非 docx 类型会拒绝)';
const DOCX_EDIT_BLOCK_SPEC = z.object({
  block_type: z.number().int().describe(DOCX_BLOCK_TYPE_DESC),
  text: z.string().optional().describe('块的纯文本内容(text/heading/列表/代码/引用 用)'),
  raw: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('完整 Feishu block JSON,需要富文本/特殊块时透传(覆盖 text 字段)'),
});

function registerDocxListBlockChildrenTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'docx_list_block_children',
    category: 'docx',
    description: D.docx_list_block_children,
    rules: ['read'],
    inputShape: {
      url_or_document_id: z.string().describe(DOCX_EDIT_URL_DESC),
      block_id: z.string().describe('父块 block_id;读取文档根传 document_id,读取表格单元格传 table_cell block_id'),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(500)
        .describe('每页数量,默认 500'),
      page_token: z.string().optional().describe('翻页 token'),
      document_revision_id: z
        .number()
        .int()
        .default(-1)
        .describe('文档版本 ID,默认 -1 表示最新版本'),
    },
    handler: async ({ url_or_document_id, block_id, page_size, page_token, document_revision_id }) => {
      const resolved = await resolveDocxDocumentId(url_or_document_id);
      if ('error' in resolved) return formatToolResult(resolved.error);
      const documentId = resolved.documentId;
      const result = await callOpenApi(
        'GET',
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(block_id)}/children`,
        {
          params: {
            page_size,
            document_revision_id,
            ...(page_token ? { page_token } : {}),
          },
        },
      );
      if (!result.ok) return formatToolResult(result);
      const data = result.data as
        | { items?: unknown[]; has_more?: boolean; page_token?: string }
        | undefined;
      return formatToolResult({
        ok: true,
        data: {
          document_id: documentId,
          parent_block_id: block_id,
          children: data?.items ?? [],
          has_more: data?.has_more,
          page_token: data?.page_token,
        },
      });
    },
  });
}

// docx_append_blocks
function registerDocxAppendBlocksTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'docx_append_blocks',
    category: 'docx',
    description: D.docx_append_blocks,
    rules: ['docx-edit', 'mutation-confirm'],
    inputShape: {
      url_or_document_id: z.string().describe(DOCX_EDIT_URL_DESC),
      parent_block_id: z
        .string()
        .optional()
        .describe('父块 block_id;不传时默认 = document_id(文档根)'),
      blocks: z.array(DOCX_EDIT_BLOCK_SPEC).min(1).describe('要追加的块列表,按数组顺序写入'),
    },
    handler: async ({ url_or_document_id, parent_block_id, blocks }) => {
      const resolved = await resolveDocxDocumentId(url_or_document_id);
      if ('error' in resolved) return formatToolResult(resolved.error);
      const documentId = resolved.documentId;

      let children;
      try {
        children = blocks.map(buildDocxBlockChild);
      } catch (e) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGS',
          data: { msg: e instanceof Error ? e.message : String(e) },
        });
      }

      const parentBlockId = parent_block_id ?? documentId;
      const result = await callFeishu((c, opts) =>
        c.docx.documentBlockChildren.create(
          {
            path: { document_id: documentId, block_id: parentBlockId },
            data: { children: children as never },
          },
          opts,
        ),
      );
      return formatToolResult(attachDocumentUrl(result, documentId));
    },
  });
}

// docx_insert_blocks
function registerDocxInsertBlocksTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'docx_insert_blocks',
    category: 'docx',
    description: D.docx_insert_blocks,
    rules: ['docx-edit', 'mutation-confirm'],
    inputShape: {
      url_or_document_id: z.string().describe(DOCX_EDIT_URL_DESC),
      parent_block_id: z
        .string()
        .describe('父块 block_id;插入到文档根传 document_id(可与 url_or_document_id 一致)'),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('插入位置(父块 children 索引);省略 = 追加到末尾'),
      blocks: z.array(DOCX_EDIT_BLOCK_SPEC).min(1).describe('要插入的块列表'),
    },
    handler: async ({ url_or_document_id, parent_block_id, index, blocks }) => {
      const resolved = await resolveDocxDocumentId(url_or_document_id);
      if ('error' in resolved) return formatToolResult(resolved.error);
      const documentId = resolved.documentId;

      let children;
      try {
        children = blocks.map(buildDocxBlockChild);
      } catch (e) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGS',
          data: { msg: e instanceof Error ? e.message : String(e) },
        });
      }

      const result = await callFeishu((c, opts) =>
        c.docx.documentBlockChildren.create(
          {
            path: { document_id: documentId, block_id: parent_block_id },
            data:
              index !== undefined
                ? { children: children as never, index }
                : { children: children as never },
          },
          opts,
        ),
      );
      return formatToolResult(attachDocumentUrl(result, documentId));
    },
  });
}

// docx_create_table
//
// 飞书建表是两段式,且和普通块完全不同:
//   1) 只发一个 table 块(block_type=31)+ property{row_size,column_size},
//      飞书后端会自动把所有 table_cell(32)和每个单元格里的空文本块(2)建出来。
//      —— 所以这里不能、也不需要手动拼单元格树(那是 documentBlockDescendant
//      的玩法,而单纯建表用 children 接口让飞书自动补全更稳)。
//   2) 要写文字时,读回自动生成的单元格(行优先顺序),每个 cell 的 children[0]
//      就是那个空文本块,再用 batch_update 把内容灌进去。
// 飞书 create 接口单表上限 9 行 × 9 列(行含表头),超了由 zod 拦下。
function registerDocxCreateTableTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'docx_create_table',
    category: 'docx',
    description: D.docx_create_table,
    rules: ['docx-edit', 'mutation-confirm'],
    inputShape: {
      url_or_document_id: z.string().describe(DOCX_EDIT_URL_DESC),
      parent_block_id: z
        .string()
        .optional()
        .describe('父块 block_id;不传时默认 = document_id(追加到文档根末尾)'),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('插入位置(父块 children 索引);省略 = 追加到末尾'),
      rows: z
        .number()
        .int()
        .min(1)
        .max(9)
        .describe('表格行数(含表头),飞书单次建表上限 9 行'),
      columns: z
        .number()
        .int()
        .min(1)
        .max(9)
        .describe('表格列数,飞书单次建表上限 9 列'),
      header_row: z
        .boolean()
        .optional()
        .describe('首行是否作为表头(加粗置灰),默认 false'),
      rows_data: z
        .array(z.array(z.string()))
        .optional()
        .describe(
          '单元格文字,二维数组按行优先填充(rows_data[行][列]);行/列可少于 rows/columns(不足留空),多出忽略。含表头时第一行即表头文字',
        ),
    },
    handler: async ({
      url_or_document_id,
      parent_block_id,
      index,
      rows,
      columns,
      header_row,
      rows_data,
    }) => {
      const resolved = await resolveDocxDocumentId(url_or_document_id);
      if ('error' in resolved) return formatToolResult(resolved.error);
      const documentId = resolved.documentId;
      const parentBlockId = parent_block_id ?? documentId;

      // ── 1) 建表骨架 ──────────────────────────────────────────────────────
      // 只发 table 块本身;飞书自动补全单元格 + 单元格内空文本块。
      const tableBlock = {
        block_type: 31,
        table: {
          property: {
            row_size: rows,
            column_size: columns,
            ...(header_row ? { header_row: true } : {}),
          },
        },
      };
      const createResult = await callOpenApi(
        'POST',
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(parentBlockId)}/children`,
        {
          data: {
            children: [tableBlock],
            ...(index !== undefined ? { index } : {}),
          },
        },
      );
      if (!createResult.ok) return formatToolResult(createResult);

      const tableBlockId = (
        createResult.data as { children?: Array<{ block_id?: string }> } | undefined
      )?.children?.[0]?.block_id;

      // 没内容要填,或没拿到表块 id(理论不该发生) → 建完即返回。
      const hasContent =
        Array.isArray(rows_data) &&
        rows_data.some((row) => row.some((cell) => cell && cell.length > 0));
      if (!tableBlockId || !hasContent) {
        return formatToolResult(
          attachDocumentUrl(
            { ok: true, data: { table_block_id: tableBlockId, rows, columns } },
            documentId,
          ),
        );
      }

      // ── 2) 读回自动生成的单元格(行优先) ────────────────────────────────
      // table 的直接子块就是单元格(32),返回顺序即行优先;每个 cell 的
      // children[0] 是要写字的空文本块。单表 ≤ 81 格,一页(500)足够,无需翻页。
      const cellsResult = await callOpenApi(
        'GET',
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(tableBlockId)}/children`,
        { params: { page_size: 500, document_revision_id: -1 } },
      );
      if (!cellsResult.ok) {
        // 表已建好,只是单元格没读到 → 明确告诉调用方表已建、内容待补,不当失败。
        return formatToolResult(
          attachDocumentUrl(
            {
              ok: true,
              data: {
                table_block_id: tableBlockId,
                rows,
                columns,
                fill_warning:
                  '表格已创建,但读取单元格失败,内容未填充。可用 docx_list_block_children + docx_update_block 手动补,或重试。',
              },
            },
            documentId,
          ),
        );
      }
      const cells =
        (cellsResult.data as { items?: Array<{ children?: string[] }> } | undefined)
          ?.items ?? [];

      // ── 3) 行优先映射内容 → 单元格文本块,组 batch_update 请求 ────────────
      const requests: Array<Record<string, unknown>> = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < columns; c++) {
          const content = rows_data?.[r]?.[c];
          if (!content) continue;
          const textId = cells[r * columns + c]?.children?.[0];
          if (!textId) continue;
          requests.push({
            block_id: textId,
            update_text_elements: { elements: [{ text_run: { content } }] },
          });
        }
      }

      // ── 4) 分批写入(batch_update 单次上限按 50 保守切片) ────────────────
      let filled = 0;
      for (let i = 0; i < requests.length; i += 50) {
        const chunk = requests.slice(i, i + 50);
        const upd = await callOpenApi(
          'PATCH',
          `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/batch_update`,
          { data: { requests: chunk } },
        );
        if (!upd.ok) {
          return formatToolResult(
            attachDocumentUrl(
              {
                ok: true,
                data: {
                  table_block_id: tableBlockId,
                  rows,
                  columns,
                  filled_cells: filled,
                  fill_warning: `表格已创建,前 ${filled} 个单元格已写入,后续 batch_update 失败。可重试或用 docx_update_block 手动补。`,
                },
              },
              documentId,
            ),
          );
        }
        filled += chunk.length;
      }

      return formatToolResult(
        attachDocumentUrl(
          { ok: true, data: { table_block_id: tableBlockId, rows, columns, filled_cells: filled } },
          documentId,
        ),
      );
    },
  });
}

// docx_update_block
function registerDocxUpdateBlockTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'docx_update_block',
    category: 'docx',
    description: D.docx_update_block,
    rules: ['docx-edit', 'mutation-confirm'],
    inputShape: {
      url_or_document_id: z.string().describe(DOCX_EDIT_URL_DESC),
      block_id: z.string().describe('要修改的块 block_id(从 docx_read 返回的 blocks 里拿)'),
      text: z
        .string()
        .optional()
        .describe('新的纯文本内容(整段覆盖该块的所有 text elements)。与 raw_update 二选一'),
      raw_update: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          '完整 patch 的 data payload,直接透传给 docx.documentBlock.patch。' +
            '富文本场景用此字段(如 update_text_style / update_table_property 等)',
        ),
    },
    handler: async ({ url_or_document_id, block_id, text, raw_update }) => {
      if (text === undefined && !raw_update) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGS',
          data: { msg: 'text 与 raw_update 必须提供其一' },
        });
      }

      const resolved = await resolveDocxDocumentId(url_or_document_id);
      if ('error' in resolved) return formatToolResult(resolved.error);
      const documentId = resolved.documentId;

      const data = (raw_update ?? {
        update_text_elements: {
          elements: [{ text_run: { content: text ?? '' } }],
        },
      }) as never;

      const result = await callFeishu((c, opts) =>
        c.docx.documentBlock.patch(
          { path: { document_id: documentId, block_id }, data },
          opts,
        ),
      );
      return formatToolResult(attachDocumentUrl(result, documentId));
    },
  });
}

// docx_delete_blocks
function registerDocxDeleteBlocksTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'docx_delete_blocks',
    category: 'docx',
    description: D.docx_delete_blocks,
    rules: ['docx-edit', 'mutation-confirm'],
    inputShape: {
      url_or_document_id: z.string().describe(DOCX_EDIT_URL_DESC),
      parent_block_id: z
        .string()
        .describe('父块 block_id;删根级块传 document_id(可与 url_or_document_id 一致)'),
      start_index: z.number().int().min(0).describe('起始索引(包含)'),
      end_index: z.number().int().min(0).describe('结束索引(不包含,左闭右开)'),
    },
    handler: async ({ url_or_document_id, parent_block_id, start_index, end_index }) => {
      if (end_index <= start_index) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_ARGS',
          data: { msg: 'end_index 必须大于 start_index(左闭右开)' },
        });
      }

      const resolved = await resolveDocxDocumentId(url_or_document_id);
      if ('error' in resolved) return formatToolResult(resolved.error);
      const documentId = resolved.documentId;

      const result = await callFeishu((c, opts) =>
        c.docx.documentBlockChildren.batchDelete(
          {
            path: { document_id: documentId, block_id: parent_block_id },
            data: { start_index, end_index },
          },
          opts,
        ),
      );
      return formatToolResult(attachDocumentUrl(result, documentId));
    },
  });
}

// docx_upload_image
function registerDocxUploadImageTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'docx_upload_image',
    category: 'docx',
    description: D.docx_upload_image,
    rules: ['docx-edit', 'mutation-confirm'],
    inputShape: {
      url_or_document_id: z.string().describe(DOCX_EDIT_URL_DESC),
      block_id: z
        .string()
        .describe('要绑定图片的 image 块 block_id(先用 docx_insert_blocks 插入 block_type=27 的空块拿到)'),
      file_path: z
        .string()
        .describe('本地图片绝对路径 / Absolute path to the local image file'),
    },
    handler: async ({ url_or_document_id, block_id, file_path }) => {
      const resolved = await resolveDocxDocumentId(url_or_document_id);
      if ('error' in resolved) return formatToolResult(resolved.error);
      const documentId = resolved.documentId;

      const guarded = await resolveUploadAbsPath(file_path);
      if (!guarded.ok) return formatToolResult(guarded.result);
      const absPath = guarded.absPath;
      if (!fs.existsSync(absPath)) {
        return formatToolResult({
          ok: false,
          errorCode: 'FILE_NOT_FOUND',
          data: { file_path: absPath, message: '文件不存在 / File does not exist' },
        });
      }

      const stat = fs.statSync(absPath);
      if (stat.size === 0) {
        return formatToolResult({
          ok: false,
          errorCode: 'INVALID_FILE',
          data: { message: '不允许上传空文件 / Empty file not allowed' },
        });
      }
      if (stat.size > 20 * 1024 * 1024) {
        return formatToolResult({
          ok: false,
          errorCode: 'FILE_TOO_LARGE',
          data: { size: stat.size, limit: 20 * 1024 * 1024, message: '文档图片不得超过 20MB(uploadAll 接口上限)' },
        });
      }

      const fileName = path.basename(absPath);

      const result = await withAuthRetry((opts) => {
        const client = getFeishuClient();
        return safeCall(async () => {
          // SDK's drive.media.uploadAll returns `{ file_token } | null` directly,
          // not the standard `{ code, msg, data }` envelope — wrap it for safeCall.
          const res = await client.drive.media.uploadAll(
            {
              data: {
                file_name: fileName,
                parent_type: 'docx_image',
                parent_node: block_id,
                size: stat.size,
                file: fs.createReadStream(absPath),
              },
            },
            opts,
          );
          return { code: 0, data: res ?? {} };
        });
      });

      if (!result.ok) {
        return formatToolResult(attachDocumentUrl(result, documentId));
      }

      const fileToken = (result.data as { file_token?: unknown } | undefined)?.file_token;
      if (typeof fileToken !== 'string' || fileToken.length === 0) {
        return formatToolResult(
          attachDocumentUrl(
            {
              ok: false,
              errorCode: 'FEISHU_API_ERROR',
              data: {
                msg: 'drive.media.uploadAll did not return file_token',
                raw: result.data,
              },
            },
            documentId,
          ),
        );
      }

      const patchResult = await callFeishu((c, opts) =>
        c.docx.documentBlock.patch(
          {
            path: { document_id: documentId, block_id },
            data: {
              replace_image: {
                token: fileToken,
              },
            },
          },
          opts,
        ),
      );

      if (!patchResult.ok) {
        return formatToolResult(
          attachDocumentUrl(
            {
              ...patchResult,
              data: {
                ...(typeof patchResult.data === 'object' && patchResult.data !== null
                  ? patchResult.data
                  : { raw: patchResult.data }),
                file_token: fileToken,
                hint: '素材已上传,但写回图片块失败;文档中可能留下空图片块',
              },
            },
            documentId,
          ),
        );
      }

      return formatToolResult(
        attachDocumentUrl(
          {
            ok: true,
            data: {
              file_token: fileToken,
              block_id,
              patch: patchResult.data,
            },
          },
          documentId,
        ),
      );
    },
  });
}

// ── Media download tool ────────────────────────────────────────────────────

// 19. media_download
function registerMediaDownloadTool(registry: FeishuToolRegistry): void {
  registry.register({
    name: 'media_download',
    category: 'misc',
    description: D.media_download,
    inputShape: {
      file_token: z
        .string()
        .describe(
          '素材标识。云文档/云盘场景:从 docx_read 等返回的 image.token / file.token。IM 消息场景:从 im_read_messages 返回的 file_key(如 img_v3_*/file_v3_*),需配合 message_id 使用。',
        ),
      message_id: z
        .string()
        .optional()
        .describe(
          'IM 消息资源下载必填(如 om_*),从 im_read_messages 返回的 message_id。传入即走 IM 路径(im.messageResource.get);不传走云文档路径(drive.media.download)。',
        ),
      resource_type: z
        .enum(['image', 'file'])
        .optional()
        .describe('IM 资源类型,仅在传 message_id 时生效。图片传 image,其他附件传 file。默认 image。'),
      extra: z
        .string()
        .optional()
        .describe('某些场景需要的 extra 参数(如多维表格附件,通常 docx 图片不用传)。仅云文档路径生效。'),
    },
    handler: async ({ file_token, message_id, resource_type, extra }) => {
      try {
        const result = await deps.getOrDownloadMedia(file_token, async (token) => {
          const fetchResult = await withAuthRetry(async (opts) => {
            const client = getFeishuClient();
            return safeCall(async () => {
              const res = message_id
                ? await client.im.messageResource.get(
                    {
                      path: { message_id, file_key: token },
                      params: { type: resource_type ?? 'image' },
                    },
                    opts,
                  )
                : await client.drive.media.download(
                    {
                      path: { file_token: token },
                      ...(extra ? { params: { extra } } : {}),
                    },
                    opts,
                  );
              const buffer = await deps.streamToBuffer(res.getReadableStream());
              const mimeType = deps.mimeFromHeaders(res.headers);
              // safeCall expects { code, msg?, data? }; pack the payload into data
              return { code: 0, data: { buffer, mimeType } };
            });
          });
          if (!fetchResult.ok) {
            throw new Error(`download failed: ${fetchResult.errorCode ?? 'unknown'}`);
          }
          const data = fetchResult.data as { buffer: Buffer; mimeType: string };
          return data;
        });

        const summary = {
          ok: true,
          file_token,
          mime: result.mimeType,
          original_path: result.originalPath,
          original_bytes: result.originalBytes,
          from_cache: result.fromCache,
          // xdt_image_url: 渲染器(聊天气泡)从这里读出来直接 <img src> 显示。
          // 仅图片文件会有此字段;非图片附件为 undefined。优先指向压缩预览,
          // 没有预览时指向原图。详见 feishuMediaStore.buildXdtImageUrl。
          ...(result.xdtImageUrl ? { xdt_image_url: result.xdtImageUrl } : {}),
          // _xdt_render_image: 媒体下载是辅助工具,不把图直接推到聊天气泡;
          // LLM 仍可从 xdt_image_url 拿到 URL,自行决定要不要在最终 markdown 里嵌入。
          // 客户端 extractToolResultImageUrls 显式 false 时跳过推流。
          ...(result.xdtImageUrl ? { _xdt_render_image: false } : {}),
          ...(result.preview
            ? {
                preview: {
                  path: result.preview.path,
                  mime: result.preview.mimeType,
                  bytes: result.preview.bytes,
                  note: '原图过大,以下为压缩后的预览版本(原图已保留在 original_path)',
                },
              }
            : {}),
        };

        const blocks: Array<
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string }
        > = [{ type: 'text' as const, text: JSON.stringify(summary) }];

        if (result.preview) {
          blocks.push({
            type: 'image' as const,
            data: result.preview.base64,
            mimeType: result.preview.mimeType,
          });
        } else if (result.inline) {
          blocks.push({
            type: 'image' as const,
            data: result.inline.base64,
            mimeType: result.inline.mimeType,
          });
        }

        return { content: blocks };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                errorCode: 'MEDIA_DOWNLOAD_FAILED',
                data: { file_token, error: msg },
              }),
            },
          ],
          isError: true,
        };
      }
    },
  });
}

// ── Entry tools (the only two surfaced on the McpServer) ────────────────────

const CATEGORY_ENUM = ['docx', 'wiki', 'bitable', 'im', 'contact', 'calendar', 'minutes', 'sheet', 'misc'] as const;

function registerListToolsEntry(server: McpServer, registry: FeishuToolRegistry): void {
  server.tool(
    'list_tools',
    D.list_tools,
    {
      category: z
        .string()
        .optional()
        .describe(
          `工具类目。不传时返回所有类目概览;传了返回该类目工具(recommended 精品 + more 全量直通)。常见精品类目:${CATEGORY_ENUM.join(' / ')};也可传任意飞书 OpenAPI project 名(如 vc / approval / corehr)。`,
        ),
      q: z
        .string()
        .optional()
        .describe('在该类目内按子串过滤 more(全量直通)工具的名称/描述,用于大类目下钻(如 q: "recording")。'),
      page: z.number().int().min(1).optional().describe('more 工具分页页码,默认 1。'),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('more 工具每页数量,默认 40。'),
    },
    async ({ category, q, page, page_size }) => {
      if (category) {
        // Normalize synonym project names to the bucket the tools actually
        // register under (e.g. `sheets`→`sheet`, `base`→`bitable`, `docs`→
        // `docx`, `directory`→`contact`), so an agent that browses by the raw
        // Feishu project name doesn't get an empty category just because the
        // tools live under the premium bucket's alias (PR #267 P2). Buckets
        // without an alias (vc / minutes / task / drive / docx / …) pass
        // through unchanged.
        const resolved = projectToCategory(category);
        const { preferred, generated } = registry.listSplit(resolved);
        // Bundle each shared rule body ONCE per response (top-level `rules`
        // map keyed by rule key). Tools reference rule keys via their
        // `rules: [...]` field; resolve every key referenced in this category.
        const ruleKeys = registry.collectRuleKeys(resolved);
        const bundledRules: Record<string, string> = {};
        for (const key of ruleKeys) {
          const body = RULES[key];
          if (body) bundledRules[key] = body;
        }
        // Generated (full-coverage) tools can number in the hundreds per
        // category — filter by `q` and paginate; premium tools stay full.
        const needle = (q ?? '').trim().toLowerCase();
        const matched = needle
          ? generated.filter(
              (t) =>
                t.name.toLowerCase().includes(needle) ||
                t.description.toLowerCase().includes(needle),
            )
          : generated;
        const size = page_size ?? 40;
        const cur = page ?? 1;
        const start = (cur - 1) * size;
        const pageItems = matched.slice(start, start + size);
        const hasMore = start + size < matched.length;
        const more =
          generated.length > 0
            ? {
                total: generated.length,
                ...(needle ? { q, matched: matched.length } : {}),
                page: cur,
                page_size: size,
                has_more: hasMore,
                ...(hasMore ? { next_page: cur + 1 } : {}),
                tools: pageItems.map((t) => ({
                  name: t.name,
                  description: t.description,
                })),
                hint: needle
                  ? '全量 OpenAPI 直通工具(优先用 recommended)。'
                  : '全量 OpenAPI 直通工具,默认折叠/分页。优先用 recommended;要定位具体接口传 q 子串过滤(如 q:"recording")或 page 翻页。',
              }
            : undefined;
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: true,
                category: resolved,
                recommended: preferred.map((t) => ({
                  name: t.name,
                  description: t.description,
                  ...(t.rules && t.rules.length > 0 ? { rules: t.rules } : {}),
                })),
                ...(more ? { more } : {}),
                ...(Object.keys(bundledRules).length > 0 ? { rules: bundledRules } : {}),
                hint: 'recommended 是精品工具(优先用);more 是全量 OpenAPI 直通工具。两者调用都用 call_tool({ name, args })。',
              }),
            },
          ],
        };
      }

      const counts: Record<string, number> = {};
      for (const t of registry.list()) {
        counts[t.category] = (counts[t.category] ?? 0) + 1;
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              categories: registry.listCategories().map((c) => ({
                name: c,
                tool_count: counts[c] ?? 0,
              })),
              hint: '用 list_tools({ category }) 查看某类目下的工具列表',
            }),
          },
        ],
      };
    },
  );
}

function registerCallToolEntry(
  server: McpServer,
  registry: FeishuToolRegistry,
): void {
  server.tool(
    'call_tool',
    D.call_tool,
    {
      name: z
        .string()
        .describe('工具名,从 list_tools 获取(如 search_and_read、bitable_list_records)'),
      args: jsonObjectArg('工具参数(JSON 对象)。不确定 schema 时可先传 {} 触发错误反馈,从返回的 schema 中读取参数定义。'),
    },
    async ({ name, args }) => registry.call(name, args),
  );
}

  // ── Build the McpServer + register tools ──────────────────────────────────
  // (we are still inside the factory closure opened near the top of this file)
  const server = new McpServer({
    name: 'lizi_feishu',
    version: '2.0.0',
  });

  // Build the registry — fine-grained tools register here, NOT on the server.
  const registry = new FeishuToolRegistry();

  // 注册顺序 = feishu_list_tools 里的类目展示顺序
  // (registry 按 Map 插入顺序去重,所以首次出现的类目就是它的位次)
  // 目标顺序: misc → wiki → bitable → docx → im → contact → calendar

  // ── misc ────────────────────────────────────────────────────────────────
  // URL-based aggregate reader
  registerReadByUrlTool(registry);
  // 唯一暴露的搜索入口,统一覆盖 wiki/docx/bitable;比纯 search 更对症
  registerSearchAndReadTool(registry);

  // ── wiki ────────────────────────────────────────────────────────────────
  // registerWikiSearchTool(registry); // 禁用:纯 search 已被 search_and_read 替代
  registerWikiListSpacesTool(registry);
  registerWikiReadTool(registry);
  registerWikiListChildrenTool(registry);
  // registerWikiRecentChangesTool(registry); // 禁用:改用 lark-cli 走 wiki nodes 递归查询
  // 写工具:调用前必须 AskUserQuestion 跟用户确认空间/父节点/标题
  registerWikiCreateNodeTool(registry);

  // ── sheet ───────────────────────────────────────────────────────────────
  registerSheetListSheetsTool(registry);
  registerSheetReadRangeTool(registry);
  registerSheetWriteRangeTool(registry);
  registerSheetAppendRowsTool(registry);

  // ── bitable ─────────────────────────────────────────────────────────────
  // registerBitableSearchTool(registry); // 禁用:同上
  registerBitableListTablesTool(registry);
  registerBitableListFieldsTool(registry);
  registerBitableListRecordsTool(registry);
  // 写工具:每个写之前必须先列出对应资源 + 用户确认(详见 rules/bitable-edit.md)
  registerBitableCreateAppTool(registry);
  registerBitableCreateTableTool(registry);
  registerBitableDeleteTableTool(registry);
  registerBitableCreateFieldTool(registry);
  registerBitableUpdateFieldTool(registry);
  registerBitableDeleteFieldTool(registry);
  registerBitableCreateRecordsTool(registry);
  registerBitableUpdateRecordsTool(registry);
  registerBitableDeleteRecordsTool(registry);

  // ── docx ────────────────────────────────────────────────────────────────
  // registerDocxSearchTool(registry); // 禁用:同上
  registerDocxReadTool(registry);
  registerDocxListBlockChildrenTool(registry);
  // 写工具:每个写之前必须先 docx_read + 用户确认
  registerDocxAppendBlocksTool(registry);
  registerDocxInsertBlocksTool(registry);
  registerDocxCreateTableTool(registry);
  registerDocxUpdateBlockTool(registry);
  registerDocxDeleteBlocksTool(registry);
  registerDocxUploadImageTool(registry);

  // ── im ──────────────────────────────────────────────────────────────────
  registerImListChatsTool(registry);
  registerImReadMessagesTool(registry);
  registerImSearchMessagesTool(registry);
  registerImSendMessageTool(registry);
  registerImUploadImageTool(registry);
  registerImUploadFileTool(registry);

  // ── contact ─────────────────────────────────────────────────────────────
  registerContactSearchTool(registry);
  registerContactGetUserTool(registry);
  registerContactBatchGetUsersTool(registry);

  // ── calendar ────────────────────────────────────────────────────────────
  registerCalendarListEventsTool(registry);
  registerCalendarGetEventTool(registry);
  registerCalendarCreateEventTool(registry);

  // ── minutes(妙记 / 会议纪要)─────────────────────────────────────────────
  registerMeetingContentTool(registry);

  // misc(再补一个,类目位次不变,因为 misc 已在最前出现过)
  registerMediaDownloadTool(registry);

  // ── 全量覆盖:vendored 官方 OpenAPI 工具(generated/,MIT)───────────────────
  // 通过我们自己的 callOpenApi(托管 user token)派发,接进同一 registry,仍只走
  // list_tools/call_tool 两个入口 —— agent 顶层工具列表与缓存前缀不变(规则 10)。
  // 放开全部 61 个域(约 1271 个接口);registerGeneratedTools 内部会跳过
  // 非 user-token 接口、以及与精品工具同名的(防遮蔽)。生成工具是 `more` 组、
  // 精品工具是 `recommended` 组,由 list_tools 分组 + 折叠/分页/过滤(q)收口。
  const genStats = registerGeneratedTools(registry, callOpenApi, formatToolResult);
  log.info(
    `[feishuMcpServer] generated tools: registered=${genStats.registered} skipped=${genStats.skipped}`,
  );

  // Expose only the two entry tools on the actual MCP server.
  registerListToolsEntry(server, registry);
  registerCallToolEntry(server, registry);

  return { server, registry };
}
