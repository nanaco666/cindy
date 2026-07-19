export interface AttachmentOssRef {
  ossKey: string;
  mimeType?: string;
  originalName?: string;
}

const ATTACH_OSS_SCHEME = 'cindy-oss-attach';
// 品牌迁移前的旧 scheme:识别面永久保留(is/parse 双认),生成面只出新 scheme。
// 旧版本桌面/手机的在途消息、本机 outbox 补发队列、sentAttachmentThumbStore 的
// 存量映射 key 都可能还是旧引用串,砍掉识别 = 旧引用附件渲染/回收全部失效。
const LEGACY_ATTACH_OSS_SCHEME = 'xdt-oss-attach';
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function buildAttachmentOssRef(ref: AttachmentOssRef): string {
  return `${ATTACH_OSS_SCHEME}://m/${toBase64Url(JSON.stringify(ref))}`;
}

export function isAttachmentOssRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith(`${ATTACH_OSS_SCHEME}://`) ||
      value.startsWith(`${LEGACY_ATTACH_OSS_SCHEME}://`))
  );
}

export function parseAttachmentOssRef(value: string): AttachmentOssRef | null {
  if (!isAttachmentOssRef(value)) return null;
  const scheme = value.startsWith(`${ATTACH_OSS_SCHEME}://`)
    ? ATTACH_OSS_SCHEME
    : LEGACY_ATTACH_OSS_SCHEME;
  const segment = value.slice(`${scheme}://m/`.length).split('/')[0];
  if (!segment) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(segment)) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.ossKey !== 'string' || record.ossKey.length === 0) return null;
    return {
      ossKey: record.ossKey,
      mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
      originalName: typeof record.originalName === 'string' ? record.originalName : undefined,
    };
  } catch {
    return null;
  }
}

function toBase64Url(input: string): string {
  return base64Encode(utf8Bytes(input))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return utf8String(base64Decode(padded));
}

function utf8Bytes(input: string): number[] {
  const escaped = encodeURIComponent(input);
  const bytes: number[] = [];
  for (let index = 0; index < escaped.length; index += 1) {
    const char = escaped[index];
    if (char === '%') {
      bytes.push(Number.parseInt(escaped.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }
  return bytes;
}

function utf8String(bytes: number[]): string {
  return decodeURIComponent(bytes.map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''));
}

function base64Encode(bytes: number[]): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const b1 = bytes[index];
    const b2 = bytes[index + 1];
    const b3 = bytes[index + 2];
    out += BASE64_ALPHABET[b1 >> 2];
    out += BASE64_ALPHABET[((b1 & 0x03) << 4) | ((b2 ?? 0) >> 4)];
    out += b2 === undefined ? '=' : BASE64_ALPHABET[((b2 & 0x0f) << 2) | ((b3 ?? 0) >> 6)];
    out += b3 === undefined ? '=' : BASE64_ALPHABET[b3 & 0x3f];
  }
  return out;
}

function base64Decode(input: string): number[] {
  const clean = input.replace(/\s/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < clean.length; index += 4) {
    const c1 = decodeBase64Char(clean[index]);
    const c2 = decodeBase64Char(clean[index + 1]);
    const c3 = clean[index + 2] === '=' ? -1 : decodeBase64Char(clean[index + 2]);
    const c4 = clean[index + 3] === '=' ? -1 : decodeBase64Char(clean[index + 3]);
    bytes.push((c1 << 2) | (c2 >> 4));
    if (c3 >= 0) bytes.push(((c2 & 0x0f) << 4) | (c3 >> 2));
    if (c4 >= 0) bytes.push(((c3 & 0x03) << 6) | c4);
  }
  return bytes;
}

function decodeBase64Char(char: string | undefined): number {
  if (!char) throw new Error('Invalid base64url attachment reference');
  const index = BASE64_ALPHABET.indexOf(char);
  if (index < 0) throw new Error('Invalid base64url attachment reference');
  return index;
}
