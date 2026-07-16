// Expo Updates Protocol manifest 构造 —— 纯函数(输入文件字节 + 元数据,输出 manifest / asset 条目)。
// 便于单测;IO(读 dist、上传 OSS)在 release-ios-ota.mjs。
//
// 参考:https://docs.expo.dev/technical-specs/expo-updates-1/ 与 expo/custom-expo-updates-server。
// 关键规则(必须与 expo-updates 客户端一致,否则下载校验失败):
//   - asset/launchAsset 的 `hash` = 文件 SHA-256 的 base64url(无 padding)编码;
//   - `key` = 文件内容的 md5 hex(客户端缓存键,只需稳定唯一);
//   - launchAsset 的 contentType 固定 application/javascript,且不带 fileExtension;
//   - 普通 asset 带 `.${ext}` 的 fileExtension 与按扩展名推断的 contentType。

import crypto from 'node:crypto';

// 常见 RN 资源扩展名 → MIME。缺省 application/octet-stream。
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  json: 'application/json', xml: 'application/xml', pdf: 'application/pdf',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
};

export function mimeForExt(ext) {
  return MIME_BY_EXT[String(ext ?? '').toLowerCase().replace(/^\./, '')] ?? 'application/octet-stream';
}

/** 文件 SHA-256 → base64url(无 padding),即 Expo manifest 的 `hash`。 */
export function base64UrlSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 文件 SHA-256 hex,用作 OSS 上的内容寻址文件名(assets/<sha256hex>)。 */
export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 文件内容 md5 hex,即 Expo manifest 的 `key`。 */
export function md5Hex(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * 构造一个 asset 条目(含 CDN url)。
 * @param {{ bytes: Buffer, ext: string, url: string, isLaunchAsset?: boolean }} input
 */
export function buildAssetEntry({ bytes, ext, url, isLaunchAsset = false }) {
  const entry = {
    hash: base64UrlSha256(bytes),
    key: md5Hex(bytes),
    contentType: isLaunchAsset ? 'application/javascript' : mimeForExt(ext),
    url,
  };
  if (!isLaunchAsset) entry.fileExtension = `.${String(ext ?? '').replace(/^\./, '')}`;
  return entry;
}

/**
 * 组装完整 manifest。launchAsset / assets 由调用方用 buildAssetEntry 备好。
 * @param {{ id: string, createdAt: string, runtimeVersion: string, launchAsset: object, assets: object[], expoClient?: object }} input
 */
export function buildManifest({ id, createdAt, runtimeVersion, launchAsset, assets, expoClient }) {
  if (!id || !createdAt || !runtimeVersion) throw new Error('buildManifest requires id / createdAt / runtimeVersion');
  if (!launchAsset) throw new Error('buildManifest requires launchAsset');
  return {
    id,
    createdAt,
    runtimeVersion,
    launchAsset,
    assets: assets ?? [],
    metadata: {},
    extra: expoClient ? { expoClient } : {},
  };
}

/**
 * runtime 基线闸门(纯判定,便于单测)。要发布的 OTA runtimeVersion 必须等于在装冷更整包
 * 记录的 runtimeVersion;不一致 / 缺基线时抛错强制走冷更。skip=true 直接放行。
 * @param {{ runtimeVersion: string, baselineRuntime: string | null | undefined, skip?: boolean, recordUrl?: string }} input
 * @returns {{ skipped: true } | { ok: true }}
 */
export function assertOtaRuntimeMatchesBaseline({ runtimeVersion, baselineRuntime, skip = false, recordUrl = '' }) {
  if (skip) return { skipped: true };
  if (baselineRuntime == null) {
    throw new Error(
      `未找到冷更装机包基线(${recordUrl}):请先 \`pnpm mobile:release:ios:local -- --execute\` 出一次冷更整包再发热更(确认无误可加 --skip-runtime-check)`,
    );
  }
  if (baselineRuntime !== runtimeVersion) {
    throw new Error(
      `runtimeVersion 与在装冷更整包不一致:本次=${runtimeVersion} 基线=${baselineRuntime};原生层已变(需先出冷更整包)或本地 release/ios-runtime.json 过期,发热更会推给收不到的 runtime——已中止(确认无误可加 --skip-runtime-check)`,
    );
  }
  return { ok: true };
}
