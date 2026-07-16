/**
 * imageRef.ts (image-local-cache M7)
 * ---------------------------------------------------------------------------
 * Type definitions and JSON parse/stringify helpers for the new persisted
 * shape of `Message.content` (role=user).
 *
 * Old format: `content` was a plain string (just the user-typed text).
 * New format: `content` is the JSON-stringified shape:
 *     { text: string, images: ImageRef[], files: FileRef[] }
 *
 * Compatibility: the parse helper recognises both formats — pre-existing
 * messages whose content is a non-JSON string are returned as-is with empty
 * images / files lists, so no server-side migration is needed.
 */

export interface ImageRef {
  /** Custom-protocol URL: 'xdt-image://{sessionId}/{filename}'. */
  url: string;
  /** image/png | image/jpeg | image/gif | image/webp. */
  mimeType: string;
  /** Original filename — used as alt text and missing-image placeholder label. */
  originalName: string;
  /**
   * 非破坏性标注(可选,向后兼容):`url` 是烧录合成图(定格模型所见)时,
   * 这里指向未烧录**原图**的缓存 url。历史图"再编辑"用它 + strokes 还原
   * 可撤销的矢量标注;原图被清理(引用悬空)时降级为在烧录图上叠新标。
   */
  annotationSourceUrl?: string;
  /** 非破坏性标注:归一化矢量笔迹(0..1 相对原图自然尺寸)。 */
  annotationStrokes?: Array<{ points: Array<{ x: number; y: number }> }>;
}

/**
 * Persisted shape for a non-image user attachment.
 * Mirrors ImageRef's "store pointer only" philosophy — only what the renderer
 * needs to re-display the chip. Inline bytes (base64 / textContent) and
 * ext / size / category / mimeType are intentionally NOT persisted: the
 * TextLightbox re-reads from `path` on demand, just like the ImageRef url
 * flow. Shape is deliberately identical to UserMessage's file prop type
 * (Array<{ name: string; path: string }>) — zero adapter on the renderer side.
 */
export interface FileRef {
  name: string;
  path: string;
}

export interface UserMessageContent {
  text: string;
  images: ImageRef[];
  files: FileRef[];
  /**
   * chat-text-quote:本消息的开头 blockquote 是"选中文字引用"功能产出,
   * 渲染层据此(且仅据此)把引用块收敛为 "N 处引用" 胶囊。缺省 / 历史消息 /
   * 用户手打的 markdown 引用不带该标志 → 原样渲染,存量呈现不变。
   */
  quotesEncoded?: boolean;
}

/**
 * Parse a `Message.content` value into { text, images, files }.
 *
 * Three input shapes are supported (type-dispatched), so historical messages
 * round-tripped through localDb's `messageToCamel` (which JSON.parses the
 * TEXT column back into objects/arrays) render correctly:
 *
 *   1. string  — legacy plain text OR JSON-stringified `{text, images, files}`
 *                OR JSON-stringified SDK content blocks `[{type,...}]`.
 *                Strings that look like JSON ('{' / '[' lead) are parsed
 *                and recursed into the relevant branch.
 *   2. array   — SDK-native content blocks: `[{type:'text',text},
 *                {type:'image',...}]`. Text blocks are concatenated;
 *                image blocks are dropped (user attachments flow through
 *                the independent `images` field, not via inline content).
 *                The SDK has no standard "file" block, so files is always [].
 *   3. object  — `{text, images, files}` shape produced by stringifyUserContent
 *                AFTER messageToCamel has parsed it back into an object.
 *
 * Anything else (null/undefined/number/unknown object shape) falls through
 * to a defensive stringify — preserving the original "don't crash" intent
 * but only firing on truly unknown shapes, not on legitimate parsed payloads.
 */
export function parseUserContent(content: unknown): UserMessageContent {
  // ── Branch 1: string ─────────────────────────────────────────────────────
  if (typeof content === 'string') {
    if (content.length === 0) return { text: '', images: [], files: [] };
    const first = content[0];
    if (first === '{' || first === '[') {
      try {
        const parsed = JSON.parse(content) as unknown;
        return parseUserContent(parsed);
      } catch {
        return { text: content, images: [], files: [] };
      }
    }
    return { text: content, images: [], files: [] };
  }

  // ── Branch 2: array — SDK-native content blocks ──────────────────────────
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          textParts.push(b.text);
        }
        // image blocks are intentionally ignored — user-message attachments
        // live in the independent `images` field on the parent shape.
        // SDK has no "file" / "document" block we want to surface here either;
        // historical SDK-array payloads never carried desktop file attachments.
      }
    }
    return { text: textParts.join(''), images: [], files: [] };
  }

  // ── Branch 3: object — already-parsed {text, images, files} shape ────────
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') {
      const rawImages = Array.isArray(obj.images) ? obj.images : [];
      const images = rawImages
        .map(coerceImageRef)
        .filter((ref): ref is ImageRef => ref !== null);
      const rawFiles = Array.isArray(obj.files) ? obj.files : [];
      const files = rawFiles.filter(isValidFileRef);
      return {
        text: obj.text,
        images,
        files,
        ...(obj.quotesEncoded === true ? { quotesEncoded: true } : {}),
      };
    }
    // Truly unknown object shape — preserve old defensive stringify behaviour.
    return { text: JSON.stringify(content), images: [], files: [] };
  }

  // ── Branch 4: null / undefined / number / boolean / symbol ───────────────
  return { text: String(content ?? ''), images: [], files: [] };
}

/**
 * Coerce a persisted image entry into ImageRef, or null if invalid.
 *
 * Accepts both filename field spellings: desktop persists `originalName`,
 * while historical mobile clients persisted `name` (schema drift shipped in
 * apps/mobile buildAttachmentPersistImageRefs — since fixed to write
 * `originalName`, but messages already stored with `name` must keep
 * rendering). Output is always normalised to `originalName`.
 */
/** 可渲染的托管图片地址:老世界 xdt-image://(历史消息)或媒体总仓 cindy-media://(新消息)。 */
function isManagedImageUrl(url: string): boolean {
  return url.startsWith('xdt-image://') || url.startsWith('cindy-media://');
}

function coerceImageRef(x: unknown): ImageRef | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.url !== 'string' || !isManagedImageUrl(o.url)) return null;
  if (typeof o.mimeType !== 'string') return null;
  const originalName =
    typeof o.originalName === 'string'
      ? o.originalName
      : typeof o.name === 'string'
        ? o.name
        : null;
  if (originalName === null) return null;
  const ref: ImageRef = { url: o.url, mimeType: o.mimeType, originalName };
  // 非破坏性标注字段:形状校验通过才成对透传(review P2:此前 coerce 只取
  // 三字段,重载 / 从存储取回后历史图丢失可再编辑数据)。半份数据没有意义,
  // 任一不合法就整体丢弃,退化为普通烧录图展示。
  const strokes = coerceAnnotationStrokes(o.annotationStrokes);
  if (
    strokes &&
    typeof o.annotationSourceUrl === 'string' &&
    isManagedImageUrl(o.annotationSourceUrl)
  ) {
    ref.annotationSourceUrl = o.annotationSourceUrl;
    ref.annotationStrokes = strokes;
  }
  return ref;
}

/** 校验并复制持久化笔迹数组;任何一处形状不合法返回 null(整体丢弃)。 */
function coerceAnnotationStrokes(
  x: unknown,
): Array<{ points: Array<{ x: number; y: number }> }> | null {
  if (!Array.isArray(x) || x.length === 0) return null;
  const strokes: Array<{ points: Array<{ x: number; y: number }> }> = [];
  for (const raw of x) {
    if (!raw || typeof raw !== 'object') return null;
    const points = (raw as { points?: unknown }).points;
    if (!Array.isArray(points) || points.length === 0) return null;
    const copied: Array<{ x: number; y: number }> = [];
    for (const p of points) {
      // p 可能是 null / 原始值:先判对象再取值,否则解引用直接 throw,
      // 一条坏笔迹记录会炸掉整个会话的消息加载(review P2)。
      if (!p || typeof p !== 'object') return null;
      const px = (p as { x?: unknown }).x;
      const py = (p as { y?: unknown }).y;
      if (typeof px !== 'number' || typeof py !== 'number' || !Number.isFinite(px) || !Number.isFinite(py)) {
        return null;
      }
      copied.push({ x: px, y: py });
    }
    strokes.push({ points: copied });
  }
  return strokes;
}

function isValidFileRef(x: unknown): x is FileRef {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.name === 'string' && typeof o.path === 'string';
}

/**
 * Serialize a user message into the new content shape. Always emits the JSON
 * form (even for empty `images` / `files`) so future readers see a uniform schema.
 *
 * `files` defaults to `[]` so legacy callers that haven't been upgraded still
 * produce a well-formed payload (and we never accidentally emit `files: undefined`,
 * which JSON.stringify would silently drop).
 */
export function stringifyUserContent(
  text: string,
  images: ImageRef[],
  files: FileRef[] = [],
  quotesEncoded = false,
): string {
  // quotesEncoded 只在为真时写入,保持旧消息 JSON 形态逐字节稳定。
  return JSON.stringify({ text, images, files, ...(quotesEncoded ? { quotesEncoded: true } : {}) });
}
