/**
 * feishuBlockManifest.ts
 * ---------------------------------------------------------------------------
 * Pure helpers for extracting an image manifest from a Feishu docx block tree.
 *
 * Why a separate module: keeps the parsing logic side-effect free so unit
 * tests don't have to mock the @larksuiteoapi SDK / electron / our token
 * manager. feishuMcpServer.ts imports from here.
 *
 * Block type cheat sheet (only the bits we use):
 *   1=page, 2=text, 3-11=heading1-heading9, 27=image
 *   Heading text lives at block[`heading${N}`].elements[].text_run.content
 */

import { FEISHU_DOC_LINK_BASE } from '../docLinks.js';

export interface ImageManifestEntry {
  /** 1-based position in document order, after dedup. */
  index: number;
  file_token: string;
  /** Nearest preceding heading text, "(开头)" if none seen yet. */
  section_hint: string;
  /** Source block_id, kept for debugging / cross-reference. */
  block_id?: string;
}

/**
 * Non-text-flow block discovered in the doc — e.g. an in-doc table, embedded
 * sheet/bitable, file attachment, iframe. rawContent does not surface these,
 * so without the manifest the LLM has no idea they exist. The entry carries
 * just enough info ("there's a table near 第二节") for the caller to decide
 * whether to follow up (sheets_read, bitable_list_records, media_download…).
 */
export interface EmbeddedBlockEntry {
  /** 1-based position in document order. */
  index: number;
  /** Source block_id, useful for follow-up tools that take block_id. */
  block_id?: string;
  /** Raw Feishu block_type number. */
  block_type: number;
  /** Friendly label: "table" / "sheet" / "iframe" / "file" / `block_${n}` for unknowns. */
  type_name: string;
  /** Nearest preceding heading text, "(开头)" if none seen yet. */
  section_hint: string;
  /** Best-effort reference: file token / iframe URL / sheet token. May be undefined. */
  ref?: string;
  /**
   * Best-effort user-clickable URL for this embed. Present when we know how
   * to construct one for the type (sheet/bitable/iframe/whiteboard). Absent
   * for types that have no standalone public URL (file/in-doc table/chat_card).
   * Designed so the LLM can drop this straight into a markdown link without
   * having to remember per-type URL conventions.
   */
  url?: string;
  /**
   * Display name of the embed. For file blocks this is filled in directly
   * from the block payload (free). For sheet / bitable / whiteboard, the
   * caller is expected to populate this via a drive.meta.batchQuery — left
   * undefined until then. buildDisplayHints prefers `title` over `type_name`
   * when constructing the link label, so e.g. "[Q4 销售数据表]" beats
   * "[电子表格]".
   */
  title?: string;
  /**
   * True when drive.meta.batchQuery returned this token in `failed_list`
   * with the requested doc_type — meaning the type we extracted from the
   * docx block (e.g. "bitable") doesn't actually match the resource on
   * Feishu's side. Most common case: a 画册 (album) embed surfaces in the
   * docx block tree as `bitable: { token }` shape, but its token isn't a
   * real bitable, so drive.meta refuses.
   *
   * When set, the caller drops `url` (the inferred one would 404) and
   * display hints render a ⚠️ warning + emphasize the raw token so the
   * user can search manually.
   */
  type_uncertain?: boolean;
}

/**
 * A heading whose children are folded (collapsed) in the Feishu UI. The
 * content is still in rawContent — the folded state is purely a visual hint
 * that the author considered this section "secondary / collapsible". We
 * surface it so the LLM can tell the user "文档里有 N 个章节默认折叠" rather
 * than treating the whole doc as one flat blob.
 */
export interface FoldedSectionEntry {
  /** 1-based position in document order, across all folded headings. */
  index: number;
  /** Source block_id of the folded heading. */
  block_id?: string;
  /** Heading level 1..9. */
  level: number;
  /** Visible heading text (best effort, text_run elements only). */
  text: string;
}

/**
 * Inline reference to another Feishu doc (`mention_doc` element inside a text
 * block). rawContent strips this to plain text — the token, obj_type, and URL
 * are all lost. We extract them as a manifest so the LLM can list "this doc
 * mentions these other docs" with clickable links, and so the user can ask
 * the agent to follow up on any of them.
 *
 * Dedup: same token appearing multiple times is collapsed to the first
 * occurrence (matches extractImagesWithSection's behaviour).
 */
export interface MentionedDocEntry {
  /** 1-based position in document order, after dedup. */
  index: number;
  /** Mentioned doc's token (obj_token, not wiki node_token). */
  token: string;
  /** Friendly type name: docx / doc / sheet / bitable / slide / mindnote / file / wiki / unknown. */
  obj_type: string;
  /** User-clickable URL. Comes from element.url when present, otherwise inferred from obj_type. */
  url: string;
  /** Nearest preceding heading text, "(开头)" if none. Same coordinate system as the other manifests. */
  section_hint: string;
  /**
   * Title of the referenced doc. Caller fills this in via drive.meta after
   * extraction — left undefined when the title hasn't been resolved
   * (e.g. unknown obj_type, permission denied, network failure). Same
   * title-preferred-over-label rule as EmbeddedBlockEntry.
   */
  title?: string;
}

/**
 * A todo item (block_type 17) with its checkbox state. rawContent gives the
 * text but drops `style.done` — without this manifest the LLM can't tell
 * what's been completed vs still open, so it can't render proper markdown
 * checkboxes (`- [x]` / `- [ ]`).
 */
export interface TodoEntry {
  /** 1-based position in document order. */
  index: number;
  block_id?: string;
  /** true = checked off / done. false = open. */
  done: boolean;
  /** Visible text (text_run elements joined). */
  text: string;
  /** Nearest preceding heading text. */
  section_hint: string;
}

/**
 * A block that contains text_runs with `text_element_style.strikethrough`.
 * rawContent flattens these to plain text, so the LLM can't tell which
 * portions were struck out by the author — typical case: an old rule with
 * the obsolete clause crossed through, which without this manifest reads
 * as a self-contradictory document ("不能买 ~~不能买~~ 可以买" becomes
 * "不能买 不能买 可以买").
 *
 * Granularity: one entry per text-bearing block that contains ANY strike
 * runs. The `text` field is the block's full visible content with `~~...~~`
 * markers re-applied around struck portions, so the agent gets both the
 * deleted text and the surrounding context in one shot.
 */
export interface StrikethroughEntry {
  /** 1-based position in document order. */
  index: number;
  block_id?: string;
  /**
   * Full block text with `~~...~~` around struck portions. Joining
   * unaltered + struck runs reproduces the visible paragraph; the markdown
   * markers tell the agent which spans are deleted vs. current. Non
   * text_run elements (mentions / equations) are skipped — they're picked
   * up by their own manifests.
   */
  text: string;
  /** Nearest preceding heading text. */
  section_hint: string;
}

const HEADING_TYPE_MIN = 3;
const HEADING_TYPE_MAX = 11;
const IMAGE_BLOCK_TYPE = 27;

// =============================================================================
// AUTHORITATIVE BLOCK_TYPE ENUM
// =============================================================================
// Source: Feishu open platform docs (BlockType enumeration table)
//   https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/docx-structure
//
// DO NOT GUESS THESE NUMBERS. They are not sequential with no gaps — e.g. 16
// is unused, 999 is the catch-all "undefined" sentinel. A previous version
// of this file had ~6 entries off by 4-10 (iframe at 28 was actually isv,
// chat_card at 30 was actually sheet, sheet at 34 was actually quote_container,
// etc.), causing real sheet embeds to render as "chat_card" with broken URLs.
// =============================================================================

const BLOCK_TYPE_NAMES: Record<number, string> = {
  1: 'page',
  2: 'text',
  3: 'heading1', 4: 'heading2', 5: 'heading3', 6: 'heading4', 7: 'heading5',
  8: 'heading6', 9: 'heading7', 10: 'heading8', 11: 'heading9',
  12: 'bullet',
  13: 'ordered',
  14: 'code',
  15: 'quote',
  17: 'todo',
  18: 'bitable',
  19: 'callout',
  20: 'chat_card',
  21: 'diagram',
  22: 'divider',
  23: 'file',
  24: 'grid',
  25: 'grid_column',
  26: 'iframe',
  27: 'image',
  28: 'isv',
  29: 'mindnote',
  30: 'sheet',
  31: 'table',
  32: 'table_cell',
  33: 'view',
  34: 'quote_container',
  35: 'task',
  36: 'okr',
  37: 'okr_objective',
  38: 'okr_key_result',
  39: 'okr_progress',
  40: 'add_ons',
  41: 'jira_issue',
  42: 'wiki_catalog',
  43: 'board',
  44: 'agenda',
  45: 'agenda_item',
  46: 'agenda_item_title',
  47: 'agenda_item_content',
  48: 'link_preview',
  49: 'source_synced',
  50: 'reference_synced',
  51: 'sub_page_list',
  52: 'ai_template',
  999: 'undefined',
};

// Named constants for block_types referenced by switch statements / set checks.
// Using these instead of magic numbers keeps the call sites self-documenting
// and prevents future drift.
const BITABLE_BLOCK_TYPE = 18;
const FILE_BLOCK_TYPE = 23;
const IFRAME_BLOCK_TYPE = 26;
const SHEET_BLOCK_TYPE = 30;
const TODO_BLOCK_TYPE = 17;
const BOARD_BLOCK_TYPE = 43;
const SOURCE_SYNCED_BLOCK_TYPE = 49;
const REFERENCE_SYNCED_BLOCK_TYPE = 50;

/**
 * Block types that are already covered by docx.document.rawContent (text flow)
 * or are pure containers whose children carry the actual content. Anything NOT
 * in this set is treated as an embedded object and surfaced via
 * extractEmbeddedBlocks.
 *
 * Source: Feishu docx block_type enum. We bias toward "definitely text" so
 * unknown / new block types fall through to the embedded list (visible) rather
 * than being silently dropped.
 */
const TEXT_FLOW_BLOCK_TYPES = new Set<number>([
  1, // page (root)
  2, // text paragraph
  3, 4, 5, 6, 7, 8, 9, 10, 11, // heading1..heading9
  12, // bullet list item
  13, // ordered list item
  14, // code block
  15, // quote block
  17, // todo
  19, // callout (container — children carry text)
  22, // divider
  24, // grid (column layout container)
  25, // grid_column
  27, // image (handled by extractImagesWithSection)
  32, // table_cell (reported via its parent table)
  34, // quote_container (container — children carry text)
  44, // agenda (container)
  45, // agenda_item (container)
  46, // agenda_item_title (text content)
  47, // agenda_item_content (text content)
]);

/**
 * Map block_type → the field name where its `elements[]` lives, for blocks
 * that carry inline text content (text_run / mention_user / mention_doc /
 * equation / …). Used by mention/todo extractors. Headings (3-11) are
 * resolved separately because the field name varies by level.
 */
const TEXT_ELEMENT_FIELD_BY_TYPE: Record<number, string> = {
  2: 'text',       // text paragraph
  12: 'bullet',    // bullet list item
  13: 'ordered',   // ordered list item
  14: 'code',      // code block
  15: 'quote',     // quote block
  17: 'todo',      // todo item
};

/**
 * Feishu obj_type (numeric, used in mention_doc elements) → friendly type
 * name. SPECULATIVE — Feishu does not publicly document the numeric
 * obj_type enum (only the string enum used by drive APIs), so these are
 * best guesses based on community projects. Treat as a fallback ONLY:
 * deriveObjTypeFromUrl below is the trusted path.
 *
 * If you see a mention labeled as "obj_type_NN" in production logs, the
 * mapping is missing — update this map and add a test.
 */
const OBJ_TYPE_TO_TYPE_NAME: Record<number, string> = {
  1: 'doc',         // legacy doc
  3: 'sheet',
  8: 'bitable',
  11: 'file',
  22: 'docx',
  // 16 / 24 / others: REMOVED — we previously had 16=slide and 24=mindnote
  // but couldn't confirm authoritatively, and the mislabel ("幻灯片" for
  // real docx documents) showed those guesses were wrong. URL-derivation
  // covers these cases reliably; the numeric map only kicks in when the
  // element omits `url`, which is rare.
};

const OBJ_TYPE_TO_URL_PATH: Record<string, string> = {
  doc: 'docs',
  docx: 'docx',
  sheet: 'sheets',
  bitable: 'base',
  slides: 'slides',
  slide: 'slides', // legacy alias
  mindnote: 'mindnotes',
  file: 'file',
  wiki: 'wiki',
  board: 'board',
};

/**
 * Recognise a Feishu doc URL and return its canonical type string. This is
 * the authoritative type signal for mention_doc — far more reliable than
 * the undocumented numeric obj_type. The URL is provided by Feishu itself
 * in the mention_doc element, so the path segment is guaranteed to match
 * the real resource type.
 *
 * Returns undefined for non-Feishu URLs or unrecognised paths so the
 * caller can fall back to the numeric obj_type map.
 */
function deriveObjTypeFromUrl(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  // Match path prefixes against known Feishu doc routes. Order doesn't
  // matter — paths are mutually exclusive.
  if (path.startsWith('/docx/')) return 'docx';
  if (path.startsWith('/docs/')) return 'doc';
  if (path.startsWith('/sheets/')) return 'sheet';
  if (path.startsWith('/base/')) return 'bitable';
  if (path.startsWith('/board/')) return 'board';
  if (path.startsWith('/slides/')) return 'slides';
  if (path.startsWith('/mindnotes/')) return 'mindnote';
  if (path.startsWith('/wiki/')) return 'wiki';
  if (path.startsWith('/file/')) return 'file';
  return undefined;
}

/**
 * Subset of Feishu's `text_element_style` we care about. The full shape
 * carries bold / italic / underline / inline_code / text_color /
 * background_color / link.url / etc. — we only surface what callers actually
 * use today (strikethrough). Add fields here as needed.
 */
interface TextElementStyle {
  /** True when the run is rendered with strikethrough in Feishu UI. */
  strikethrough?: boolean;
}

interface TextRunElement {
  text_run?: {
    content?: string;
    text_element_style?: TextElementStyle;
  };
  mention_user?: { user_id?: string };
  mention_doc?: {
    token?: string;
    obj_type?: number;
    /** Canonical URL when Feishu provides it inline (often present). */
    url?: string;
    /** Doc title when Feishu provides it inline (often present). */
    title?: string;
  };
}

interface HeadingShape {
  elements?: TextRunElement[];
  style?: { folded?: boolean };
}

interface TodoShape {
  elements?: TextRunElement[];
  style?: { done?: boolean };
}

interface BlockShape {
  block_id?: string;
  block_type?: number;
  image?: { token?: string };
  [key: string]: unknown;
}

/**
 * Concatenate the visible text of a heading block. Feishu represents heading
 * content as `heading1.elements[].text_run.content` (likewise heading2..9).
 * Non text_run elements (mentions, etc.) are skipped — section_hint is for
 * locating, not for full fidelity.
 */
function extractHeadingText(block: BlockShape, headingLevel: number): string {
  const key = `heading${headingLevel}`;
  const heading = block[key] as HeadingShape | undefined;
  if (!heading?.elements) return '';
  const parts: string[] = [];
  for (const el of heading.elements) {
    const content = el?.text_run?.content;
    if (typeof content === 'string' && content.length > 0) parts.push(content);
  }
  return parts.join('').trim();
}

/**
 * Walk Feishu blocks (in document order) and build an image manifest:
 * each image gets its position index plus a section_hint (nearest preceding
 * heading text). Callers use this to lazy-fetch only relevant images.
 *
 * Dedup: if the same file_token appears multiple times we keep the first
 * occurrence (with its first section_hint) — Feishu can reference the same
 * image asset twice.
 */
export function extractImagesWithSection(
  blocks: unknown[],
): ImageManifestEntry[] {
  const seen = new Set<string>();
  const out: ImageManifestEntry[] = [];
  let currentHeading = '';

  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as BlockShape;
    const type = block.block_type;

    if (
      typeof type === 'number' &&
      type >= HEADING_TYPE_MIN &&
      type <= HEADING_TYPE_MAX
    ) {
      const level = type - 2; // 3 → heading1, 11 → heading9
      const text = extractHeadingText(block, level);
      if (text) currentHeading = text;
      continue;
    }

    if (type === IMAGE_BLOCK_TYPE) {
      const token = block.image?.token;
      if (typeof token !== 'string' || token.length === 0) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      out.push({
        index: out.length + 1,
        file_token: token,
        section_hint: currentHeading || '(开头)',
        block_id: typeof block.block_id === 'string' ? block.block_id : undefined,
      });
    }
  }
  return out;
}

/**
 * Generic composite-token splitter. Multiple Feishu embed types store their
 * reference as `{resourceToken}_{subId}`:
 *   - bitable: `{appToken}_{tableId}`  (tableId always starts with `tbl`)
 *   - sheet:   `{spreadsheetToken}_{sheetTabId}`  (no fixed prefix)
 *
 * Both forms break drive.meta.batchQuery + the public URL path when passed
 * as-is. The path expects only the main token; the sub-id is a query param
 * (`?table=...` / `?sheet=...`).
 *
 * Heuristic: split on the FIRST underscore. Feishu resource tokens
 * themselves don't contain underscores (they're base62/alphanumeric), so
 * the first `_` reliably marks the boundary between main_token and sub_id.
 * Returns `{ main_token: <whole token>, sub_id: undefined }` when there's
 * no underscore — backwards compatible with non-composite tokens.
 */
export function splitCompositeToken(token: string): {
  main_token: string;
  sub_id?: string;
} {
  const idx = token.indexOf('_');
  if (idx === -1) return { main_token: token };
  return {
    main_token: token.slice(0, idx),
    sub_id: token.slice(idx + 1),
  };
}

/**
 * Bitable-specific composite split. Exported for backwards compatibility +
 * to keep call sites that explicitly handle bitables readable. Returns
 * the older field names (`app_token` / `table_id`) for clarity.
 */
export function splitBitableToken(token: string): {
  app_token: string;
  table_id?: string;
} {
  const { main_token, sub_id } = splitCompositeToken(token);
  return { app_token: main_token, table_id: sub_id };
}

/**
 * Append a query parameter to a URL, picking `?` or `&` based on whether
 * the URL already has a query string. Used to layer `?table=...` onto
 * drive.meta's canonical bitable URL without breaking existing params.
 */
function appendQueryParam(url: string, key: string, value: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

/**
 * Best-effort: pull a useful identifier off an embedded block. Different block
 * types put their token / URL in different shapes; fall through to undefined
 * when the field isn't present (caller still gets block_id + type_name).
 */
function extractEmbedRef(block: BlockShape, type: number): string | undefined {
  if (type === FILE_BLOCK_TYPE) {
    // file (23): { file: { token: "..." } }
    const file = block.file as { token?: string } | undefined;
    return typeof file?.token === 'string' && file.token.length > 0 ? file.token : undefined;
  }
  if (type === IFRAME_BLOCK_TYPE) {
    // iframe (26): { iframe: { component: { url: "..." } } } (newer)
    //                OR { iframe: { url: "..." } } (older).
    const iframe = block.iframe as
      | { component?: { url?: string }; url?: string }
      | undefined;
    const url = iframe?.component?.url ?? iframe?.url;
    return typeof url === 'string' && url.length > 0 ? url : undefined;
  }
  if (type === BITABLE_BLOCK_TYPE) {
    // bitable embed (18): { bitable: { token: "appToken_tableId" } }
    // Token is composite; callers can split via splitBitableToken.
    const bitable = block.bitable as { token?: string } | undefined;
    return typeof bitable?.token === 'string' && bitable.token.length > 0
      ? bitable.token
      : undefined;
  }
  if (type === SHEET_BLOCK_TYPE) {
    // sheet embed (30): { sheet: { token: "..." } }
    const sheet = block.sheet as { token?: string } | undefined;
    return typeof sheet?.token === 'string' && sheet.token.length > 0
      ? sheet.token
      : undefined;
  }
  if (type === BOARD_BLOCK_TYPE) {
    // board / 画板 (43): { board: { token: "..." } }. Some older SDK
    // versions shipped this as `whiteboard: { token }` — keep that as a
    // defensive fallback so docs written against the legacy shape still
    // surface tokens.
    const board = block.board as { token?: string } | undefined;
    if (typeof board?.token === 'string' && board.token.length > 0) return board.token;
    const wb = block.whiteboard as { token?: string } | undefined;
    if (typeof wb?.token === 'string' && wb.token.length > 0) return wb.token;
    return undefined;
  }
  if (type === REFERENCE_SYNCED_BLOCK_TYPE || type === SOURCE_SYNCED_BLOCK_TYPE) {
    // Sync blocks (49 source, 50 reference): { source_synced: {...} } /
    // { reference_synced: {...} }. Both shapes carry source_doc_token +
    // source_block_id pointing at the original. Try the canonical field
    // first, then probe legacy names as a defensive fallback.
    const fieldName =
      type === SOURCE_SYNCED_BLOCK_TYPE ? 'source_synced' : 'reference_synced';
    const data = block[fieldName] as
      | { source_block_id?: string; source_doc_token?: string }
      | undefined;
    if (typeof data?.source_block_id === 'string' && data.source_block_id.length > 0) {
      return data.source_block_id;
    }
    // Legacy shapes from older SDK versions:
    const sync = block.sync as { source_block_id?: string } | undefined;
    const ref = block.block_ref as { source_block_id?: string } | undefined;
    const legacy = sync?.source_block_id ?? ref?.source_block_id;
    if (typeof legacy === 'string' && legacy.length > 0) return legacy;
    return undefined;
  }
  return undefined;
}

/**
 * Best-effort: pull a display title directly from the block payload (no
 * extra API call). Only file blocks carry `file.name`, which we use as the
 * title. Everything else requires a drive.meta lookup the caller does
 * separately — returns undefined here.
 */
function extractEmbedTitle(block: BlockShape, type: number): string | undefined {
  if (type === FILE_BLOCK_TYPE) {
    const file = block.file as { name?: string } | undefined;
    if (typeof file?.name === 'string' && file.name.length > 0) return file.name;
  }
  return undefined;
}

/**
 * Build a deep-link URL into a sync block's source doc + block. Sync blocks
 * mirror content from another location; the most useful "click" is a jump
 * to the original block via Feishu's URL fragment syntax. Returns undefined
 * if we don't have both the source doc token and the source block id.
 */
function buildSyncBlockUrl(block: BlockShape, type: number): string | undefined {
  // Try the canonical field name for the specific sync type first, then
  // fall back through legacy shapes that older SDK versions used.
  const canonicalField =
    type === SOURCE_SYNCED_BLOCK_TYPE ? 'source_synced' : 'reference_synced';
  const data = block[canonicalField] as
    | { source_doc_token?: string; source_block_id?: string }
    | undefined;
  const sync = block.sync as
    | { source_doc_token?: string; source_block_id?: string }
    | undefined;
  const ref = block.block_ref as
    | { source_doc_token?: string; source_block_id?: string }
    | undefined;
  const docToken = data?.source_doc_token ?? sync?.source_doc_token ?? ref?.source_doc_token;
  const blockId = data?.source_block_id ?? sync?.source_block_id ?? ref?.source_block_id;
  if (!docToken || !blockId) return undefined;
  return `${FEISHU_DOC_LINK_BASE}/docx/${docToken}#${blockId}`;
}

/**
 * Build a user-clickable URL for an embedded object when we know the type's
 * URL convention. Returns undefined for types with no standalone public URL
 * (file attachments, in-doc tables, chat cards). The point is to give the
 * LLM something it can drop into a markdown link without per-type knowledge.
 *
 * The `block` arg is needed for sync blocks (38) which build their URL from
 * two fields (source_doc_token + source_block_id), not from a single ref.
 */
function buildEmbedUrl(
  type: number,
  ref: string | undefined,
  block: BlockShape,
): string | undefined {
  if (type === SOURCE_SYNCED_BLOCK_TYPE || type === REFERENCE_SYNCED_BLOCK_TYPE) {
    return buildSyncBlockUrl(block, type);
  }
  if (!ref) return undefined;
  switch (type) {
    case BITABLE_BLOCK_TYPE: {
      // bitable — ref is the composite "appToken_tableId" form (per Feishu
      // BlockBitable). The URL path takes only appToken; the table is a
      // query param. Without splitting, the URL 404s because the path
      // rejects the composite.
      const { main_token, sub_id } = splitCompositeToken(ref);
      const base = `${FEISHU_DOC_LINK_BASE}/base/${main_token}`;
      return sub_id ? `${base}?table=${encodeURIComponent(sub_id)}` : base;
    }
    case IFRAME_BLOCK_TYPE: // iframe — ref is already a URL
      return ref;
    case SHEET_BLOCK_TYPE: {
      // sheet — ref MAY be composite "{spreadsheet_token}_{sheet_tab_id}".
      // Same problem as bitable: pass the composite to /sheets/ and you 404,
      // because the path expects only the spreadsheet_token. Split + layer
      // the tab id as ?sheet=... so the user lands on the right tab.
      const { main_token, sub_id } = splitCompositeToken(ref);
      const base = `${FEISHU_DOC_LINK_BASE}/sheets/${main_token}`;
      return sub_id ? `${base}?sheet=${encodeURIComponent(sub_id)}` : base;
    }
    case BOARD_BLOCK_TYPE: // board (画板)
      return `${FEISHU_DOC_LINK_BASE}/board/${ref}`;
    default:
      return undefined;
  }
}

/**
 * Apply a drive.meta-returned URL to an entry, preserving the bitable table
 * context. drive.meta gives the canonical (tenant-aware) URL of the bitable
 * APP — but the original embed pointed at a specific TABLE inside it. We
 * layer the `?table=...` query param back on so clicking lands on the right
 * table, not the bitable's default view.
 *
 * For non-bitable types, returns the canonical URL unchanged.
 */
export function applyCanonicalUrl(
  canonicalUrl: string,
  type: number,
  originalRef: string | undefined,
): string {
  if (!originalRef) return canonicalUrl;
  if (type === BITABLE_BLOCK_TYPE) {
    const { sub_id } = splitCompositeToken(originalRef);
    return sub_id ? appendQueryParam(canonicalUrl, 'table', sub_id) : canonicalUrl;
  }
  if (type === SHEET_BLOCK_TYPE) {
    const { sub_id } = splitCompositeToken(originalRef);
    return sub_id ? appendQueryParam(canonicalUrl, 'sheet', sub_id) : canonicalUrl;
  }
  return canonicalUrl;
}

/**
 * Walk Feishu blocks in document order and surface every block that ISN'T
 * already covered by text flow or the image manifest — embedded tables,
 * sheets, files, iframes, etc.
 *
 * Why: docx.document.rawContent silently drops the contents of in-doc tables
 * and embedded objects, so without this list the LLM has no hint that they
 * exist. The entry's section_hint lets the caller localize "the table is
 * under 第二节" without re-paginating the block list.
 *
 * Heading tracking mirrors extractImagesWithSection so the two manifests use
 * the same coordinate system.
 */
export function extractEmbeddedBlocks(blocks: unknown[]): EmbeddedBlockEntry[] {
  const out: EmbeddedBlockEntry[] = [];
  let currentHeading = '';

  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as BlockShape;
    const type = block.block_type;
    if (typeof type !== 'number') continue;

    if (type >= HEADING_TYPE_MIN && type <= HEADING_TYPE_MAX) {
      const level = type - 2;
      const text = extractHeadingText(block, level);
      if (text) currentHeading = text;
      continue;
    }

    if (TEXT_FLOW_BLOCK_TYPES.has(type)) continue;

    const ref = extractEmbedRef(block, type);
    const url = buildEmbedUrl(type, ref, block);
    const title = extractEmbedTitle(block, type);
    out.push({
      index: out.length + 1,
      block_id: typeof block.block_id === 'string' ? block.block_id : undefined,
      block_type: type,
      type_name: BLOCK_TYPE_NAMES[type] ?? `block_${type}`,
      section_hint: currentHeading || '(开头)',
      ...(ref ? { ref } : {}),
      ...(url ? { url } : {}),
      ...(title ? { title } : {}),
    });
  }
  return out;
}

/**
 * Walk Feishu blocks and surface headings whose children are folded in the
 * Feishu UI (`heading{N}.style.folded === true`). The content itself IS in
 * rawContent — folded state is a UI hint that the author considered this
 * section secondary. Surfacing it lets the LLM mention "文档中有 N 个折叠
 * 章节" so the user knows where to look if the summary feels incomplete.
 *
 * Returns empty array when no folded headings exist (caller decides whether
 * to omit the field entirely).
 */
export function extractFoldedSections(blocks: unknown[]): FoldedSectionEntry[] {
  const out: FoldedSectionEntry[] = [];

  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as BlockShape;
    const type = block.block_type;
    if (typeof type !== 'number') continue;
    if (type < HEADING_TYPE_MIN || type > HEADING_TYPE_MAX) continue;

    const level = type - 2; // 3 → heading1
    const heading = block[`heading${level}`] as HeadingShape | undefined;
    if (heading?.style?.folded !== true) continue;

    const text = extractHeadingText(block, level);
    out.push({
      index: out.length + 1,
      block_id: typeof block.block_id === 'string' ? block.block_id : undefined,
      level,
      text: text || '(无标题)',
    });
  }
  return out;
}

/**
 * Resolve the `elements` array for a block that carries inline text. Headings
 * (3-11) use `heading{level}.elements`; other text-bearing blocks (text,
 * bullet, ordered, code, quote, todo) use a fixed key looked up in
 * TEXT_ELEMENT_FIELD_BY_TYPE. Returns undefined for blocks that don't carry
 * inline elements at all (image, divider, embedded objects, etc.).
 */
function getTextElements(block: BlockShape): TextRunElement[] | undefined {
  const type = block.block_type;
  if (typeof type !== 'number') return undefined;

  if (type >= HEADING_TYPE_MIN && type <= HEADING_TYPE_MAX) {
    const heading = block[`heading${type - 2}`] as HeadingShape | undefined;
    return heading?.elements;
  }

  const fieldName = TEXT_ELEMENT_FIELD_BY_TYPE[type];
  if (!fieldName) return undefined;
  const shape = block[fieldName] as { elements?: TextRunElement[] } | undefined;
  return shape?.elements;
}

/**
 * Concatenate visible text_run content from a list of inline elements.
 * Non text_run elements (mentions / equations / inline_blocks) are skipped —
 * the result is for "what the user would read", which mentions get replaced
 * into separately via the mention manifests.
 */
function joinTextRuns(elements: TextRunElement[] | undefined): string {
  if (!elements) return '';
  const parts: string[] = [];
  for (const el of elements) {
    const content = el?.text_run?.content;
    if (typeof content === 'string' && content.length > 0) parts.push(content);
  }
  return parts.join('').trim();
}

/**
 * Walk Feishu blocks and collect every inline `mention_doc` element across
 * all text-bearing block types. rawContent flattens these to plain text,
 * losing the token + obj_type — without this manifest the LLM can't tell
 * the user "this doc references docs A, B, C" with clickable links.
 *
 * Dedup: same token kept only once (first occurrence wins), matches the
 * image manifest's behavior.
 *
 * URL preference: the element's own `url` field is trusted when present;
 * otherwise the URL is inferred from `obj_type` via OBJ_TYPE_TO_URL_PATH.
 * Unknown obj_type falls back to the docx path (most common, click-safe).
 */
export function extractMentionedDocs(blocks: unknown[]): MentionedDocEntry[] {
  const out: MentionedDocEntry[] = [];
  const seen = new Set<string>();
  let currentHeading = '';

  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as BlockShape;
    const type = block.block_type;
    if (typeof type !== 'number') continue;

    // Update heading context first — also lets headings themselves carry
    // mention_doc elements (rare but valid; we still collect them).
    if (type >= HEADING_TYPE_MIN && type <= HEADING_TYPE_MAX) {
      const level = type - 2;
      const text = extractHeadingText(block, level);
      if (text) currentHeading = text;
    }

    const elements = getTextElements(block);
    if (!elements) continue;

    for (const el of elements) {
      const md = el?.mention_doc;
      if (!md) continue;
      const token = md.token;
      if (typeof token !== 'string' || token.length === 0) continue;
      if (seen.has(token)) continue;
      seen.add(token);

      const inlineUrl =
        typeof md.url === 'string' && md.url.length > 0 ? md.url : undefined;
      const inlineTitle =
        typeof md.title === 'string' && md.title.length > 0 ? md.title : undefined;

      // PREFERRED: derive type from the URL Feishu gave us — it's the
      // authoritative signal because Feishu owns the URL routing.
      // FALLBACK: numeric obj_type (undocumented, may be wrong for some
      // values). LAST RESORT: 'unknown' so the entry still surfaces.
      const objTypeFromUrl = inlineUrl ? deriveObjTypeFromUrl(inlineUrl) : undefined;
      const objTypeFromNumber =
        typeof md.obj_type === 'number'
          ? OBJ_TYPE_TO_TYPE_NAME[md.obj_type]
          : undefined;
      const objTypeName = objTypeFromUrl ?? objTypeFromNumber ?? 'unknown';

      // Both bitable AND sheet mention tokens can be composite (main_token
      // + sub_id). When the element didn't provide its own URL, split for
      // the fallback URL so we don't 404. When the element DID provide a
      // URL, trust it as-is (already canonical).
      let url: string;
      if (inlineUrl) {
        url = inlineUrl;
      } else if (objTypeName === 'bitable') {
        const { main_token, sub_id } = splitCompositeToken(token);
        const base = `${FEISHU_DOC_LINK_BASE}/base/${main_token}`;
        url = sub_id ? `${base}?table=${encodeURIComponent(sub_id)}` : base;
      } else if (objTypeName === 'sheet') {
        const { main_token, sub_id } = splitCompositeToken(token);
        const base = `${FEISHU_DOC_LINK_BASE}/sheets/${main_token}`;
        url = sub_id ? `${base}?sheet=${encodeURIComponent(sub_id)}` : base;
      } else {
        // Unknown type without URL: best-effort docx path. If wrong, the
        // user still has the token in display hints to search manually.
        const urlPath = OBJ_TYPE_TO_URL_PATH[objTypeName] ?? 'docx';
        url = `${FEISHU_DOC_LINK_BASE}/${urlPath}/${token}`;
      }

      out.push({
        index: out.length + 1,
        token,
        obj_type: objTypeName,
        url,
        section_hint: currentHeading || '(开头)',
        ...(inlineTitle ? { title: inlineTitle } : {}),
      });
    }
  }
  return out;
}

/**
 * Walk Feishu blocks and collect every `mention_user` open_id referenced in
 * inline text elements. Caller is expected to feed these to
 * resolveOpenIdsToNames so the LLM can substitute `@ou_xxx` placeholders
 * (which is what rawContent gives) with human names in its summary.
 *
 * Returns a deduped list (order: first-seen).
 */
export function extractMentionedUserIds(blocks: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const elements = getTextElements(raw as BlockShape);
    if (!elements) continue;
    for (const el of elements) {
      const id = el?.mention_user?.user_id;
      if (typeof id !== 'string' || id.length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Walk Feishu blocks and surface every todo (block_type 17) with its
 * checkbox state. rawContent only gives the visible text — `style.done` is
 * dropped, so without this manifest the LLM can't render proper markdown
 * checkboxes (`- [x]` / `- [ ]`).
 */
export function extractTodos(blocks: unknown[]): TodoEntry[] {
  const out: TodoEntry[] = [];
  let currentHeading = '';

  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as BlockShape;
    const type = block.block_type;
    if (typeof type !== 'number') continue;

    if (type >= HEADING_TYPE_MIN && type <= HEADING_TYPE_MAX) {
      const level = type - 2;
      const text = extractHeadingText(block, level);
      if (text) currentHeading = text;
      continue;
    }

    if (type !== TODO_BLOCK_TYPE) continue;

    const todo = block.todo as TodoShape | undefined;
    const text = joinTextRuns(todo?.elements);
    const done = todo?.style?.done === true;

    out.push({
      index: out.length + 1,
      block_id: typeof block.block_id === 'string' ? block.block_id : undefined,
      done,
      text: text || '(无内容)',
      section_hint: currentHeading || '(开头)',
    });
  }
  return out;
}

/**
 * Walk Feishu blocks and surface every text-bearing block that contains at
 * least one strikethrough text_run. rawContent strips formatting, so without
 * this manifest the LLM reads struck-out clauses as if they were still
 * authoritative — causing it to cite obsolete rules / contradict the doc.
 *
 * Block scope: same set as getTextElements (text, headings 1-9, bullet,
 * ordered, code, quote, todo). Within each qualifying block, every text_run
 * is examined; if at least one is struck, ONE entry is emitted with the
 * full block text where struck portions are wrapped in `~~...~~`.
 *
 * Why one-entry-per-block (not per-run): the agent needs to see what was
 * deleted AND what surrounds it. A bare "~~不能买~~" is useless; the agent
 * needs "旧规则: ~~不能买~~ 新规则: 可以买" to understand the edit.
 */
export function extractStrikethroughs(blocks: unknown[]): StrikethroughEntry[] {
  const out: StrikethroughEntry[] = [];
  let currentHeading = '';

  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as BlockShape;
    const type = block.block_type;
    if (typeof type !== 'number') continue;

    if (type >= HEADING_TYPE_MIN && type <= HEADING_TYPE_MAX) {
      const level = type - 2;
      const headingText = extractHeadingText(block, level);
      if (headingText) currentHeading = headingText;
      // Headings themselves can carry struck runs — fall through to inspect.
    }

    const elements = getTextElements(block);
    if (!elements) continue;

    let hasStrike = false;
    const parts: string[] = [];
    for (const el of elements) {
      const content = el?.text_run?.content;
      if (typeof content !== 'string' || content.length === 0) continue;
      const struck = el.text_run?.text_element_style?.strikethrough === true;
      if (struck) {
        hasStrike = true;
        parts.push(`~~${content}~~`);
      } else {
        parts.push(content);
      }
    }
    if (!hasStrike) continue;

    out.push({
      index: out.length + 1,
      block_id: typeof block.block_id === 'string' ? block.block_id : undefined,
      text: parts.join('').trim(),
      section_hint: currentHeading || '(开头)',
    });
  }
  return out;
}

/**
 * Map a raw type_name (sheet / bitable / whiteboard / …) to a human-readable
 * Chinese label suitable for surfacing to end users. Keeps the display layer
 * in one place so the LLM doesn't have to translate.
 */
function labelForEmbedType(typeName: string): string {
  switch (typeName) {
    case 'sheet':
      return '电子表格';
    case 'bitable':
      return '多维表格';
    case 'board':
    case 'whiteboard': // legacy alias from earlier (wrong) mapping
      return '画板';
    case 'iframe':
      return '外部嵌入';
    case 'file':
      return '附件文件';
    case 'table':
      return '文档内嵌表格';
    case 'chat_card':
      return '聊天卡片';
    case 'diagram':
    case 'block_diagram': // legacy alias from earlier (wrong) mapping
      return '流程图';
    case 'reference_synced':
      return '同步块(引用)';
    case 'source_synced':
      return '同步块(源)';
    case 'sync_block': // legacy alias from earlier (wrong) mapping
      return '同步块';
    case 'mindnote':
      return '思维笔记';
    case 'isv':
      return '第三方应用';
    case 'add_ons':
      return '组件 add-on';
    case 'jira_issue':
      return 'Jira 工单';
    case 'link_preview':
      return '链接预览';
    case 'wiki_catalog':
    case 'sub_page_list':
      return '子页面列表';
    case 'ai_template':
      return 'AI 模板';
    case 'task':
      return '任务';
    case 'view':
      return '内嵌视图';
    default:
      return typeName;
  }
}

/**
 * Map mention_doc obj_type → Chinese label. Same idea as labelForEmbedType
 * but for inline doc references.
 */
function labelForObjType(objType: string): string {
  switch (objType) {
    case 'docx':
      return '新版文档';
    case 'doc':
      return '旧版文档';
    case 'sheet':
      return '电子表格';
    case 'bitable':
      return '多维表格';
    case 'slides':
    case 'slide': // legacy alias
      return '幻灯片';
    case 'mindnote':
      return '思维笔记';
    case 'file':
      return '云盘文件';
    case 'wiki':
      return '知识库节点';
    case 'board':
      return '画板';
    case 'unknown':
      return '飞书文档';
    default:
      return '飞书文档';
  }
}

/**
 * Compose the link label for an embedded/mentioned entry in the display
 * hints. Three pieces are combined into one parens group so the user sees
 * everything they need in a single readable token:
 *
 *   - `title` (preferred when present) — e.g. "Q4 销售数据表"
 *   - `typeLabel` (always present)     — e.g. "电子表格"
 *   - `sectionHint` (when non-trivial) — e.g. "第二节"
 *
 * Output examples:
 *   - title + section:     "Q4 销售数据表(电子表格,在「第二节」)"
 *   - title only:          "Q4 销售数据表(电子表格)"
 *   - no title + section:  "电子表格(在「第二节」)"
 *   - no title, no section:"电子表格"
 */
/**
 * Build the "raw identifier" suffix shown after every embedded entry.
 * Always emits SOMETHING when we have any identifier so the user can copy
 * it to search Feishu manually — critical when our URL guess is wrong (e.g.
 * 画册 misidentified as bitable, unknown block_type, drive.meta failed).
 *
 * Priority: ref (the actual resource token) over block_id (the location
 * inside the parent doc). For embeds with both, ref is what the user
 * actually needs to find the resource. block_id is the position-in-doc
 * fallback when there's no resource token (in-doc table, chat_card, etc.).
 */
function formatIdentifier(
  ref: string | undefined,
  blockId: string | undefined,
): string {
  if (ref) return ` \`${ref}\``;
  if (blockId) return ` block_id \`${blockId}\``;
  return '';
}

/**
 * Whether a URL points to a Feishu wiki node. Wiki URLs are the only
 * embed/mention URL family we trust to render as a clickable link, because
 * Feishu wiki has built-in tenant routing — `https://feishu.cn/wiki/<token>`
 * resolves to the correct tenant for any viewer with permission. All other
 * doc-type paths (`/docx`, `/sheets`, `/base`, `/file`, `/slides`, …) need
 * the tenant subdomain prefix, and our inferred bare URLs were 404ing /
 * landing on login pages in the field.
 *
 * Match is path-based, not host-based: catches both `feishu.cn/wiki/...`
 * and `xindong.feishu.cn/wiki/...`, future-proof against any other tenant
 * hosts Feishu might serve from.
 */
function isWikiUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /\/wiki\//.test(url);
}

function buildEmbedLinkLabel(
  title: string | undefined,
  typeLabel: string,
  sectionHint: string,
): string {
  const hasSection = sectionHint && sectionHint !== '(开头)';
  const sectionPart = hasSection ? `在「${sectionHint}」` : '';

  if (title) {
    const inside = sectionPart ? `${typeLabel},${sectionPart}` : typeLabel;
    return `${title}(${inside})`;
  }
  return sectionPart ? `${typeLabel}(${sectionPart})` : typeLabel;
}

/**
 * Build a pre-formatted markdown block summarising embedded objects + folded
 * sections. The LLM gets this in the tool response alongside the JSON, and
 * is far more likely to paste it into the final reply verbatim than to
 * reconstruct the same content from the JSON fields (empirically ~95% vs
 * ~70% display rate). Returns undefined when there's nothing to show, so
 * the caller can skip adding an empty block.
 *
 * Display-layer logic kept here (next to the data extractors) so the entire
 * "what to surface for embeds" contract lives in one testable module.
 */
export function buildDisplayHints(
  embedded: EmbeddedBlockEntry[],
  folded: FoldedSectionEntry[],
  mentionedDocs: MentionedDocEntry[] = [],
  todos: TodoEntry[] = [],
  strikethroughs: StrikethroughEntry[] = [],
): string | undefined {
  const totalItems =
    embedded.length +
    folded.length +
    mentionedDocs.length +
    todos.length +
    strikethroughs.length;
  if (totalItems === 0) return undefined;

  const parts: string[] = [];
  parts.push('=== 推荐附在总结末尾的清单(已格式化,直接复制到回复末尾即可) ===');
  parts.push('');

  // Top-line totals: explicit numeric signal so the LLM knows what to expect.
  // The hard rule in read.md says "每个 section 的条目数必须与这一行的数字
  // 完全一致" — gives a self-check the model can verify before sending.
  const overview: string[] = [];
  if (embedded.length > 0) overview.push(`${embedded.length} 个嵌入对象`);
  if (mentionedDocs.length > 0) overview.push(`${mentionedDocs.length} 个文档引用`);
  if (todos.length > 0) overview.push(`${todos.length} 个任务项`);
  if (strikethroughs.length > 0) overview.push(`${strikethroughs.length} 处删除线内容`);
  if (folded.length > 0) overview.push(`${folded.length} 个折叠章节`);
  parts.push(`📊 本文档总览:${overview.join(' / ')}(下方逐条列出,⚠️ 写回复时不能省略任何一条)`);
  parts.push('');

  if (embedded.length > 0) {
    // No URL hyperlinks here. Empirically every per-tenant docx embed URL we
    // inferred (sheet/bitable/file/iframe/board) failed to redirect to the
    // right tenant — only wiki-path URLs route correctly across tenants.
    // Surface label + token instead and tell the user to paste the token
    // back into this chat — the agent can then read it via the proper
    // typed tool (sheets_read_range / bitable_list_records / media_download
    // / etc.), which is more useful than opening it in Feishu themselves.
    parts.push(
      `📎 嵌入对象(共 ${embedded.length} 个,全部列出),不附链接,默认未展开。需要继续查看时,把下方 token 复制回对话框告诉我,我会继续帮你读:`,
    );
    for (const e of embedded) {
      const linkLabel = buildEmbedLinkLabel(
        e.title,
        labelForEmbedType(e.type_name),
        e.section_hint,
      );
      // ref (resource token) > block_id (in-doc location) — same fallback
      // chain as before, just without the URL tier on top.
      const identifier = formatIdentifier(e.ref, e.block_id);

      if (e.type_uncertain) {
        // drive.meta refused this token under the assumed type (most often
        // 画册 surfacing as bitable). Type label might be wrong; warn the
        // user so they don't trust it blindly.
        parts.push(`- ⚠️ ${linkLabel}${identifier} —— 类型识别可能有误`);
      } else {
        parts.push(`- ${linkLabel}${identifier}`);
      }
    }
    parts.push('');
  }

  if (mentionedDocs.length > 0) {
    // Mentioned docs is the only place wiki URLs realistically show up
    // (in-doc embeds aren't wiki). Wiki paths route correctly across
    // tenants, so those stay as clickable markdown links. Everything else
    // gets the same label + token treatment as embedded.
    parts.push(
      `🔗 文中引用的飞书文档(共 ${mentionedDocs.length} 个,全部列出),非 wiki 链接已去掉,默认未跟进。需要继续查看时,把下方 token 复制回对话框告诉我,我会继续帮你读:`,
    );
    for (const m of mentionedDocs) {
      const linkLabel = buildEmbedLinkLabel(
        m.title,
        labelForObjType(m.obj_type),
        m.section_hint,
      );
      if (isWikiUrl(m.url)) {
        parts.push(`- [${linkLabel}](${m.url}) \`${m.token}\``);
      } else {
        parts.push(`- ${linkLabel} \`${m.token}\``);
      }
    }
    parts.push('');
  }

  if (todos.length > 0) {
    const open = todos.filter((t) => !t.done).length;
    const done = todos.length - open;
    parts.push(
      `✅ 任务项(共 ${todos.length} 个,全部列出 / 已完成 ${done} / 未完成 ${open}),总结涉及任务时请用 \`- [x]\` / \`- [ ]\` 形式:`,
    );
    for (const t of todos) {
      const mark = t.done ? '[x]' : '[ ]';
      const section = t.section_hint && t.section_hint !== '(开头)' ? ` _(${t.section_hint})_` : '';
      parts.push(`- ${mark} ${t.text}${section}`);
    }
    parts.push('');
  }

  if (strikethroughs.length > 0) {
    // rawContent strips the strikethrough styling — without surfacing this,
    // the LLM treats deleted clauses as still authoritative and contradicts
    // the document. The list shows the FULL block text with `~~...~~` around
    // struck spans so the agent has both the deletion and its context.
    parts.push(
      `🚫 删除线内容(共 ${strikethroughs.length} 处,全部列出 / 已被作者划掉表示弃用,引用文档规则时请把 \`~~...~~\` 当成"已删除",不要写进现行结论里):`,
    );
    for (const s of strikethroughs) {
      const section =
        s.section_hint && s.section_hint !== '(开头)' ? ` _(${s.section_hint})_` : '';
      const id = s.block_id ? ` block_id \`${s.block_id}\`` : '';
      parts.push(`- ${s.text}${section}${id}`);
    }
    parts.push('');
  }

  if (folded.length > 0) {
    const titles = folded.map((f) => `「${f.text}」`).join('、');
    parts.push(
      `📁 默认折叠的章节(共 ${folded.length} 个,全部列出 / 内容已包含在正文里):${titles}`,
    );
  }

  return parts.join('\n').trimEnd();
}
