/**
 * attachmentOssRef.ts — device-link 出方向附件的「OSS 中转引用」编解码。
 * ---------------------------------------------------------------------------
 * 控制端给远程会话发附件时,本机字节(xdt-image:// 缓存 / 绝对路径 / base64)经 OSS 直传,
 * 然后把附件 block 的 path/url 替换成本引用串(一个伪 scheme 字符串),随 invoke 走 relay
 * 到被控端。被控端 normalizeUserMessage 识别此引用 → presign-get 下载 → 物化成本地文件喂 agent。
 *
 * 为什么用「path 位置的引用串」而非新增字段:enqueue 路径经 buildMakerUserMessage 把
 * AgentInputSerializedFile 收敛成 `{type, path: f.url||f.path, mimeType}` —— 只有 path/url/base64
 * 三个口子能过。把引用塞进 url/path 让出/入两条 channel(send 直接 block、enqueue 经 builder)
 * 在被控端收敛到**同一个 block.path 引用串**,只需 normalizeUserMessage 一处识别。
 *
 * 引用串:`cindy-oss-attach://m/{base64url(JSON{ossKey,mimeType?,originalName?})}`
 * ossKey 含 `/`,故整体 base64url 编码塞进单个路径段,无歧义。
 */
import { toBase64Url, fromBase64Url } from './remoteMediaUrl';

export const ATTACH_OSS_SCHEME = 'cindy-oss-attach';
/**
 * 品牌迁移前的旧 scheme:识别面永久保留(is/parse 双认),生成面只出新 scheme。
 * 旧版本控制端(含更新节奏慢的手机版)在途 invoke、离线 outbox 补发、被控端
 * 重启恢复的未物化队列里都可能还是旧引用串,砍掉识别 = 旧端附件静默丢失。
 */
export const LEGACY_ATTACH_OSS_SCHEME = 'xdt-oss-attach';

export interface AttachmentOssRef {
  ossKey: string;
  mimeType?: string;
  originalName?: string;
}

/** 组装 OSS 附件引用串。 */
export function buildAttachmentOssRef(ref: AttachmentOssRef): string {
  return `${ATTACH_OSS_SCHEME}://m/${toBase64Url(JSON.stringify(ref))}`;
}

/** 该字符串是否是 OSS 附件引用(新旧 scheme 双认)。 */
export function isAttachmentOssRef(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    (s.startsWith(`${ATTACH_OSS_SCHEME}://`) || s.startsWith(`${LEGACY_ATTACH_OSS_SCHEME}://`))
  );
}

/** 解析 OSS 附件引用 → { ossKey, mimeType?, originalName? };非法 → null。 */
export function parseAttachmentOssRef(s: string): AttachmentOssRef | null {
  if (!isAttachmentOssRef(s)) return null;
  const scheme = s.startsWith(`${ATTACH_OSS_SCHEME}://`)
    ? ATTACH_OSS_SCHEME
    : LEGACY_ATTACH_OSS_SCHEME;
  const seg = s.slice(`${scheme}://m/`.length).split('/')[0];
  if (!seg) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(seg)) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.ossKey !== 'string' || !o.ossKey) return null;
    return {
      ossKey: o.ossKey,
      mimeType: typeof o.mimeType === 'string' ? o.mimeType : undefined,
      originalName: typeof o.originalName === 'string' ? o.originalName : undefined,
    };
  } catch {
    return null;
  }
}
