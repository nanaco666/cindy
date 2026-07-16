// 冷更安装包 OSS 直发 helper —— 全部纯函数,供 release-android-local.mjs /
// release-ios-local.mjs 组装安装包在自有 OSS/CDN 上的 key/URL、iOS itms
// manifest plist 与安装页 HTML。上传 IO 仍走 scripts/shared/oss.mjs。
//
// 背景:冷更安装包分发从 NPKG 迁到自有阿里云 OSS。
//   - Android:自签 APK 即终版,直传 OSS,installUrl = CDN 直链。
//   - iOS:企业重签仍靠 NPKG(证书在 NPKG 侧),重签后的 ipa 下载回来传 OSS,
//     并自行生成 itms manifest plist(苹果 OTA 安装协议要求,必须 HTTPS)与安装页。

const UNSAFE_SEGMENT = /[^A-Za-z0-9._-]/g;

/** 把 version / buildNumber 等外部值收敛成安全的文件名片段(OSS key / URL 友好)。 */
export function sanitizeFileSegment(value, fallback = 'unknown') {
  const s = String(value ?? '').replace(UNSAFE_SEGMENT, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

function assertHttpsUrl(url, what) {
  if (!/^https:\/\//.test(String(url ?? ''))) {
    throw new Error(`${what} 必须是 HTTPS 地址(iOS itms 安装是苹果硬性要求),got: ${url}`);
  }
}

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Android 冷更 APK 的 OSS key 与 CDN 直链(按 versionCode 分目录,天然 immutable)。
 * @returns {{ key: string, url: string, fileName: string }}
 */
export function buildAndroidDistTarget({ ossPrefix, cdnBase, version, versionCode }) {
  if (!ossPrefix || !cdnBase) throw new Error('buildAndroidDistTarget requires ossPrefix / cdnBase');
  if (versionCode == null || versionCode === '') throw new Error('buildAndroidDistTarget requires versionCode');
  const code = sanitizeFileSegment(versionCode);
  const fileName = `xdmaker-${sanitizeFileSegment(version, 'v')}-${code}.apk`;
  const dir = `mobile-dist/android/${code}`;
  return { key: `${ossPrefix}/${dir}/${fileName}`, url: `${cdnBase}/${dir}/${fileName}`, fileName };
}

/**
 * 解析 `aapt2 dump badging <apk>` 的 stdout,抽出内嵌 package / versionCode / versionName。
 * 纯函数(spawn/定位 aapt2 由调用方做),用于上传前校验 APK 与本次发版目标一致。
 * @returns {{ package: string|null, versionCode: string|null, versionName: string|null }}
 */
export function parseApkBadging(badgingStdout) {
  const line = String(badgingStdout ?? '').split('\n').find((l) => l.startsWith('package:')) ?? '';
  const pick = (k) => (line.match(new RegExp(`${k}='([^']*)'`)) ?? [])[1] ?? null;
  return { package: pick('name'), versionCode: pick('versionCode'), versionName: pick('versionName') };
}

/**
 * 断言 APK 内嵌 manifest 的 package / versionCode 与本次发版目标一致,不一致(或解析不出)即抛错。
 * 兜住 `--apk` 手动传入 stale / 包名错的外部预构包被直传 OSS 并写进 release.json 的风险。
 */
export function assertApkMetadata(badging, { expectPackage, expectVersionCode }) {
  if (!badging?.package || badging.versionCode == null) {
    throw new Error('无法从 APK 解析 package/versionCode(aapt2 dump badging 输出异常)');
  }
  if (badging.package !== expectPackage) {
    throw new Error(`APK package 不匹配:内嵌 ${badging.package},期望 ${expectPackage}(--apk 传错包?)`);
  }
  if (String(badging.versionCode) !== String(expectVersionCode)) {
    throw new Error(`APK versionCode 不匹配:内嵌 ${badging.versionCode},期望 ${expectVersionCode}(--apk stale?)`);
  }
}

/**
 * iOS 冷更分发三件套(企业重签 ipa / itms manifest plist / 安装页)的 OSS key 与 CDN 直链,
 * 按 buildNumber 分目录。
 * @returns {{ ipa: {key:string,url:string}, manifest: {key:string,url:string}, page: {key:string,url:string} }}
 */
export function buildIosDistTargets({ ossPrefix, cdnBase, version, buildNumber }) {
  if (!ossPrefix || !cdnBase) throw new Error('buildIosDistTargets requires ossPrefix / cdnBase');
  if (buildNumber == null || buildNumber === '') throw new Error('buildIosDistTargets requires buildNumber');
  const build = sanitizeFileSegment(buildNumber);
  const dir = `mobile-dist/ios/${build}`;
  const ipaFile = `xdmaker-${sanitizeFileSegment(version, 'v')}-${build}.ipa`;
  const entry = (file) => ({ key: `${ossPrefix}/${dir}/${file}`, url: `${cdnBase}/${dir}/${file}` });
  return { ipa: entry(ipaFile), manifest: entry('manifest.plist'), page: entry('install.html') };
}

/**
 * 生成 iOS OTA 安装的 manifest plist(itms-services 协议指向的那份)。
 * ipaUrl 必须 HTTPS;bundle-version 必须用 IPA 的 CFBundleVersion(= ios.buildNumber),
 * 不能用营销版本号 expo.version——冷更常见 buildNumber 递增而 version 不变,若这里写营销
 * 版本号,manifest 会与已装版本同号,iOS OTA 可能判为"已安装同版本"而拒绝/空跑装机。
 */
export function buildItmsManifestPlist({ ipaUrl, bundleId, buildNumber, title }) {
  assertHttpsUrl(ipaUrl, 'itms manifest 的 ipa 地址');
  if (!bundleId || buildNumber == null || buildNumber === '') {
    throw new Error('buildItmsManifestPlist requires bundleId / buildNumber');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>items</key>
    <array>
        <dict>
            <key>assets</key>
            <array>
                <dict>
                    <key>kind</key>
                    <string>software-package</string>
                    <key>url</key>
                    <string>${escapeXml(ipaUrl)}</string>
                </dict>
            </array>
            <key>metadata</key>
            <dict>
                <key>bundle-identifier</key>
                <string>${escapeXml(bundleId)}</string>
                <key>bundle-version</key>
                <string>${escapeXml(buildNumber)}</string>
                <key>kind</key>
                <string>software</string>
                <key>title</key>
                <string>${escapeXml(title || 'XDMaker')}</string>
            </dict>
        </dict>
    </array>
</dict>
</plist>
`;
}

/** manifest plist 的 CDN 地址 → itms-services 安装链接(plist 地址必须 HTTPS)。 */
export function buildItmsUrl(plistUrl) {
  assertHttpsUrl(plistUrl, 'itms manifest plist 地址');
  return `itms-services://?action=download-manifest&url=${encodeURIComponent(plistUrl)}`;
}

/**
 * 极简安装页(installUrl 的落地页):Safari 打开点按钮即触发 itms 安装。
 * release.json 的 installUrl 指向它,作为 itmsUrl 之外的可分享网页入口。
 */
export function buildInstallHtml({ itmsUrl, title, version, buildNumber }) {
  if (!itmsUrl) throw new Error('buildInstallHtml requires itmsUrl');
  const name = escapeHtml(title || 'XDMaker');
  const ver = escapeHtml([version, buildNumber].filter(Boolean).join(' · '));
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} 安装</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #16161a; color: #f4f4f2; font-family: -apple-system, "PingFang SC", sans-serif; }
  main { text-align: center; padding: 32px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #9a9a94; font-size: 14px; margin: 0 0 28px; }
  a.install { display: inline-block; padding: 14px 44px; border-radius: 10px; background: #f4f4f2;
              color: #16161a; font-size: 17px; font-weight: 600; text-decoration: none; }
  small { display: block; margin-top: 24px; color: #6b6b66; font-size: 12px; line-height: 1.6; }
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <p>${ver}</p>
  <a class="install" href="${escapeHtml(itmsUrl)}">安装到 iPhone</a>
  <small>请用 Safari 打开本页。首次安装后如提示"不受信任",<br>前往 设置 → 通用 → VPN 与设备管理 中信任企业开发者。</small>
</main>
</body>
</html>
`;
}
