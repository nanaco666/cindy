// @ts-nocheck —— 被测对象是 .mjs 发布工具模块,vitest 跑其纯函数(冷更安装包 OSS 直发 helper)。
import { describe, expect, it } from 'vitest';
import {
  sanitizeFileSegment,
  buildAndroidDistTarget,
  buildIosDistTargets,
  buildItmsManifestPlist,
  buildItmsUrl,
  buildInstallHtml,
  parseApkBadging,
  assertApkMetadata,
} from '../../scripts/lib/oss-dist.mjs';

describe('sanitizeFileSegment', () => {
  it('保留安全字符,收敛其它字符为 -', () => {
    expect(sanitizeFileSegment('1.2.3')).toBe('1.2.3');
    expect(sanitizeFileSegment('1.0.0 beta/±x')).toBe('1.0.0-beta--x');
  });
  it('空值回退 fallback', () => {
    expect(sanitizeFileSegment('', 'v')).toBe('v');
    expect(sanitizeFileSegment('///', 'v')).toBe('v');
  });
});

describe('buildAndroidDistTarget', () => {
  it('按 versionCode 分目录拼 key 与 CDN 直链', () => {
    const t = buildAndroidDistTarget({ ossPrefix: 'xdt-maker', cdnBase: 'https://cdn.example.com/xdt-maker', version: '1.2.3', versionCode: 2026070101 });
    expect(t.key).toBe('xdt-maker/mobile-dist/android/2026070101/Cindy-1.2.3-2026070101.apk');
    expect(t.url).toBe('https://cdn.example.com/xdt-maker/mobile-dist/android/2026070101/Cindy-1.2.3-2026070101.apk');
  });
  it('缺 versionCode / cdnBase 抛错', () => {
    expect(() => buildAndroidDistTarget({ ossPrefix: 'p', cdnBase: 'https://c', version: '1', versionCode: '' })).toThrow();
    expect(() => buildAndroidDistTarget({ ossPrefix: 'p', version: '1', versionCode: 1 })).toThrow();
  });
});

describe('buildIosDistTargets', () => {
  it('按 buildNumber 分目录产出 ipa / manifest / page 三件套', () => {
    const t = buildIosDistTargets({ ossPrefix: 'xdt-maker', cdnBase: 'https://cdn.example.com/xdt-maker', version: '1.2.3', buildNumber: '2026070102' });
    expect(t.ipa.key).toBe('xdt-maker/mobile-dist/ios/2026070102/Cindy-1.2.3-2026070102.ipa');
    expect(t.manifest.url).toBe('https://cdn.example.com/xdt-maker/mobile-dist/ios/2026070102/manifest.plist');
    expect(t.page.url).toBe('https://cdn.example.com/xdt-maker/mobile-dist/ios/2026070102/install.html');
  });
});

describe('buildItmsManifestPlist', () => {
  it('包含 ipa 地址 / bundle id,并做 XML 转义', () => {
    const xml = buildItmsManifestPlist({
      ipaUrl: 'https://cdn.example.com/a.ipa?x=1&y=2',
      bundleId: 'com.xd.lizcn',
      buildNumber: '2026070102',
      title: 'XDMaker',
    });
    expect(xml).toContain('<string>https://cdn.example.com/a.ipa?x=1&amp;y=2</string>');
    expect(xml).toContain('<string>com.xd.lizcn</string>');
    expect(xml).toContain('<string>software-package</string>');
  });
  it('bundle-version 用 buildNumber(CFBundleVersion),不是营销版本号', () => {
    // 冷更常见 buildNumber 递增而 version 不变——bundle-version 必须跟 IPA 的 CFBundleVersion,
    // 否则 iOS OTA 会判为"已安装同版本"拒绝装机。
    const xml = buildItmsManifestPlist({ ipaUrl: 'https://cdn/a.ipa', bundleId: 'com.xd.lizcn', buildNumber: '2026070105' });
    expect(xml).toMatch(/<key>bundle-version<\/key>\s*<string>2026070105<\/string>/);
  });
  it('拒绝非 HTTPS 的 ipa 地址(苹果硬性要求)', () => {
    expect(() => buildItmsManifestPlist({ ipaUrl: 'http://cdn/a.ipa', bundleId: 'b', buildNumber: '1' })).toThrow(/HTTPS/);
  });
  it('缺 bundleId / buildNumber 抛错', () => {
    expect(() => buildItmsManifestPlist({ ipaUrl: 'https://cdn/a.ipa', bundleId: 'b' })).toThrow(/buildNumber/);
    expect(() => buildItmsManifestPlist({ ipaUrl: 'https://cdn/a.ipa', buildNumber: '1' })).toThrow();
  });
});

describe('parseApkBadging / assertApkMetadata', () => {
  const badging = [
    "package: name='com.xd.lizcn' versionCode='2026070101' versionName='1.2.3' compileSdkVersion='34'",
    "sdkVersion:'24'",
    "application-label:'XDMaker'",
  ].join('\n');

  it('从 aapt2 dump badging 输出解析 package/versionCode/versionName', () => {
    expect(parseApkBadging(badging)).toEqual({ package: 'com.xd.lizcn', versionCode: '2026070101', versionName: '1.2.3' });
  });
  it('解析不出 package 行时字段为 null', () => {
    expect(parseApkBadging('sdkVersion:\'24\'')).toEqual({ package: null, versionCode: null, versionName: null });
  });
  it('package / versionCode 一致时通过', () => {
    expect(() => assertApkMetadata(parseApkBadging(badging), { expectPackage: 'com.xd.lizcn', expectVersionCode: 2026070101 })).not.toThrow();
  });
  it('package 不匹配抛错', () => {
    expect(() => assertApkMetadata(parseApkBadging(badging), { expectPackage: 'com.xdtmaker.mobile', expectVersionCode: 2026070101 })).toThrow(/package 不匹配/);
  });
  it('versionCode 不匹配抛错', () => {
    expect(() => assertApkMetadata(parseApkBadging(badging), { expectPackage: 'com.xd.lizcn', expectVersionCode: 2026070199 })).toThrow(/versionCode 不匹配/);
  });
  it('解析不出内容抛错', () => {
    expect(() => assertApkMetadata({ package: null, versionCode: null }, { expectPackage: 'x', expectVersionCode: 1 })).toThrow(/无法从 APK 解析/);
  });
});

describe('buildItmsUrl', () => {
  it('对 plist 地址做完整 URL 编码', () => {
    expect(buildItmsUrl('https://cdn.example.com/m.plist')).toBe(
      'itms-services://?action=download-manifest&url=https%3A%2F%2Fcdn.example.com%2Fm.plist',
    );
  });
  it('拒绝非 HTTPS plist 地址', () => {
    expect(() => buildItmsUrl('http://cdn/m.plist')).toThrow(/HTTPS/);
  });
});

describe('buildInstallHtml', () => {
  it('安装页含 itms 链接(HTML 转义)与版本信息', () => {
    const html = buildInstallHtml({ itmsUrl: 'itms-services://?action=download-manifest&url=x', title: 'XDMaker', version: '1.2.3', buildNumber: '2026070102' });
    expect(html).toContain('href="itms-services://?action=download-manifest&amp;url=x"');
    expect(html).toContain('1.2.3 · 2026070102');
  });
  it('缺 itmsUrl 抛错', () => {
    expect(() => buildInstallHtml({})).toThrow();
  });
});
