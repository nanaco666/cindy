// @ts-nocheck —— 被测对象是 .mjs 发布工具模块,vitest 跑其纯函数。
import { describe, expect, it } from 'vitest';
import { productionEndpoints } from '../../../../scripts/shared/production-endpoints.mjs';

const NPKG_INSTALL_URL = `${productionEndpoints.npkgBaseUrl}/install/4567`;
import {
  parseNpkgInstallLinks,
  compareBuildNumbers,
  assertBuildNumberMonotonic,
  buildExportOptionsPlist,
  buildReleaseRecord,
  fetchBaselineBuildNumber,
  nextDateBuildNumber,
  replaceBuildNumberInAppJson,
  resolveIosSigningEnv,
} from '../../scripts/lib/ios-local.mjs';

const resp = (status, { json, ok } = {}) => ({
  status,
  ok: ok ?? (status >= 200 && status < 300),
  json: json ?? (async () => ({})),
});

describe('parseNpkgInstallLinks', () => {
  it('从 release-ios.sh 输出提取 install / itms / childId', () => {
    const out = [
      '  安装链接(发这个):',
      `    ${NPKG_INSTALL_URL}`,
      '  itms-services : itms-services://?action=download-manifest&url=https%3A%2F%2Fx%2Fplist%2F4567',
    ].join('\n');
    const r = parseNpkgInstallLinks(out);
    expect(r.installUrl).toBe(NPKG_INSTALL_URL);
    expect(r.childId).toBe('4567');
    expect(r.itmsUrl).toContain('itms-services://');
  });
  it('无链接 → 全 null', () => {
    expect(parseNpkgInstallLinks('nothing here')).toEqual({ installUrl: null, itmsUrl: null, childId: null });
  });
});

describe('compareBuildNumbers / assertBuildNumberMonotonic', () => {
  it('数值串比较', () => {
    expect(compareBuildNumbers('2026070102', '2026070101')).toBe(1);
    expect(compareBuildNumbers('2026070101', '2026070101')).toBe(0);
  });
  it('首发(无 previous)放行', () => {
    expect(assertBuildNumberMonotonic('2026070101', null)).toBe(true);
    expect(assertBuildNumberMonotonic('2026070101', '')).toBe(true);
  });
  it('递增放行,非递增抛错', () => {
    expect(assertBuildNumberMonotonic('2026070102', '2026070101')).toBe(true);
    expect(() => assertBuildNumberMonotonic('2026070101', '2026070101')).toThrow(/必须大于/);
    expect(() => assertBuildNumberMonotonic('', '1')).toThrow();
  });
});

describe('resolveIosSigningEnv', () => {
  const FULL = {
    XDT_IOS_TEAM_ID: 'TEAM123456',
    XDT_IOS_PROFILE_NAME: 'some_profile',
    XDT_IOS_SIGN_IDENTITY: 'Apple Development',
  };
  it('三项必填 env 齐全 → 透传;profilePath 可选缺省为空串', () => {
    expect(resolveIosSigningEnv(FULL)).toEqual({
      teamId: 'TEAM123456', profileName: 'some_profile', identity: 'Apple Development', profilePath: '',
    });
    expect(resolveIosSigningEnv({ ...FULL, XDT_IOS_PROFILE_PATH: '/tmp/p.mobileprovision' }).profilePath)
      .toBe('/tmp/p.mobileprovision');
  });
  it('缺任一必填项 → 抛错并点名缺失的 env(零代码默认值,不回落)', () => {
    expect(() => resolveIosSigningEnv({ ...FULL, XDT_IOS_TEAM_ID: '' })).toThrow(/XDT_IOS_TEAM_ID/);
    expect(() => resolveIosSigningEnv({ ...FULL, XDT_IOS_PROFILE_NAME: ' ' })).toThrow(/XDT_IOS_PROFILE_NAME/);
    expect(() => resolveIosSigningEnv({ ...FULL, XDT_IOS_SIGN_IDENTITY: undefined })).toThrow(/XDT_IOS_SIGN_IDENTITY/);
  });
  it('全缺 → 错误信息按序列出全部三项', () => {
    expect(() => resolveIosSigningEnv({})).toThrow(/XDT_IOS_TEAM_ID, XDT_IOS_PROFILE_NAME, XDT_IOS_SIGN_IDENTITY/);
  });
});

describe('buildExportOptionsPlist', () => {
  it('含 development / manual / team / profile 映射', () => {
    const plist = buildExportOptionsPlist({ teamId: 'NTC4BJ542G', bundleId: 'com.xd.cindycn', profileName: 'cindycn_dev' });
    expect(plist).toContain('<string>development</string>');
    expect(plist).toContain('<string>manual</string>');
    expect(plist).toContain('<string>NTC4BJ542G</string>');
    expect(plist).toContain('<key>com.xd.cindycn</key>');
    expect(plist).toContain('<string>cindycn_dev</string>');
  });
  it('缺参抛错', () => {
    expect(() => buildExportOptionsPlist({ teamId: 'x', bundleId: 'y' })).toThrow();
  });
});

describe('buildReleaseRecord', () => {
  it('组装记录,可选字段按需带上', () => {
    const r = buildReleaseRecord({
      version: '1.2.0', buildNumber: '2026070101', runtimeVersion: 'rtv1',
      installUrl: 'https://x/install/1', itmsUrl: 'itms-services://?u=1', releaseNotes: 'fix',
    });
    expect(r).toMatchObject({ version: '1.2.0', runtimeVersion: 'rtv1', releaseNotes: 'fix' });
    expect(r.minVersion).toBeUndefined();
  });
  it('缺 runtimeVersion 或安装地址抛错', () => {
    expect(() => buildReleaseRecord({ installUrl: 'x' })).toThrow();
    expect(() => buildReleaseRecord({ runtimeVersion: 'r' })).toThrow();
  });
});

describe('fetchBaselineBuildNumber (fail-closed)', () => {
  const URL = 'https://cdn/x/release.json';
  it('200 有记录 → 返回 buildNumber', async () => {
    const f = async () => resp(200, { json: async () => ({ buildNumber: '2026070101' }) });
    await expect(fetchBaselineBuildNumber(URL, f)).resolves.toBe('2026070101');
  });
  it('读取 URL 带 ?t= cache-bust(可变指针不被 CDN 边缘钉死)', async () => {
    let seen = '';
    const f = async (u) => { seen = u; return resp(200, { json: async () => ({ buildNumber: '1' }) }); };
    await fetchBaselineBuildNumber(URL, f);
    expect(seen).toMatch(/^https:\/\/cdn\/x\/release\.json\?t=\d+$/);
  });
  it('404 → null(合法首发)', async () => {
    await expect(fetchBaselineBuildNumber(URL, async () => resp(404))).resolves.toBeNull();
  });
  it('200 但缺 buildNumber 字段 → 抛错(记录损坏,fail-closed,不当首发)', async () => {
    const f = async () => resp(200, { json: async () => ({}) });
    await expect(fetchBaselineBuildNumber(URL, f)).rejects.toThrow(/缺 buildNumber/);
  });
  it('500 / 403 → 抛错(不当成首发)', async () => {
    await expect(fetchBaselineBuildNumber(URL, async () => resp(500))).rejects.toThrow(/HTTP 500/);
    await expect(fetchBaselineBuildNumber(URL, async () => resp(403))).rejects.toThrow(/HTTP 403/);
  });
  it('网络错误 → 抛错', async () => {
    const f = async () => { throw new TypeError('Failed to fetch'); };
    await expect(fetchBaselineBuildNumber(URL, f)).rejects.toThrow(/网络错误/);
  });
  it('JSON 解析失败 → 抛错', async () => {
    const f = async () => resp(200, { json: async () => { throw new SyntaxError('bad json'); } });
    await expect(fetchBaselineBuildNumber(URL, f)).rejects.toThrow(/JSON 解析失败/);
  });
});

describe('nextDateBuildNumber(冷更自动 bump)', () => {
  const JUL6 = new Date(2026, 6, 6); // 2026-07-06(本地时区)

  it('无 current/previous → 今天的 YYYYMMDD01', () => {
    expect(nextDateBuildNumber(null, null, JUL6)).toBe('2026070601');
    expect(nextDateBuildNumber('', '', JUL6)).toBe('2026070601');
  });
  it('基线是往日 → 跳到今天的 YYYYMMDD01', () => {
    expect(nextDateBuildNumber('2026070301', '2026070301', JUL6)).toBe('2026070601');
  });
  it('同天再次冷更 → 末两位序号递增', () => {
    expect(nextDateBuildNumber('2026070601', '2026070601', JUL6)).toBe('2026070602');
    expect(nextDateBuildNumber('2026070601', '2026070602', JUL6)).toBe('2026070603');
  });
  it('基线比今天日期基还大(旧线遗留大号)→ 直接 +1 保单调', () => {
    expect(nextDateBuildNumber('4', '2026081599', JUL6)).toBe('2026081600');
  });
  it('月/日补零', () => {
    expect(nextDateBuildNumber(null, null, new Date(2026, 0, 5))).toBe('2026010501');
  });
  it('非纯数字串(带点等)→ 抛错回退手动 bump', () => {
    expect(() => nextDateBuildNumber('1.2.3', null, JUL6)).toThrow(/不是纯数字串/);
    expect(() => nextDateBuildNumber('2026070601', '1.2', JUL6)).toThrow(/不是纯数字串/);
  });
});

describe('replaceBuildNumberInAppJson', () => {
  const RAW = [
    '{',
    '  "expo": {',
    '    "version": "1.0.0",',
    '    "ios": {',
    '      "buildNumber": "2026070301",',
    '      "bundleIdentifier": "com.xd.lizcn"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  it('只替换 buildNumber 一行,其余格式零改动', () => {
    const out = replaceBuildNumberInAppJson(RAW, '2026070601');
    expect(out).toBe(RAW.replace('"2026070301"', '"2026070601"'));
    expect(JSON.parse(out).expo.ios.buildNumber).toBe('2026070601');
  });
  it('buildNumber 为空串也能替换', () => {
    const out = replaceBuildNumberInAppJson(RAW.replace('"2026070301"', '""'), '2026070601');
    expect(JSON.parse(out).expo.ios.buildNumber).toBe('2026070601');
  });
  it('0 处或多处 buildNumber → 抛错防误替换', () => {
    expect(() => replaceBuildNumberInAppJson('{}', '2026070601')).toThrow(/出现 0 处/);
    expect(() => replaceBuildNumberInAppJson(`${RAW}${RAW}`, '2026070601')).toThrow(/出现 2 处/);
  });
  it('新号非纯数字 → 抛错', () => {
    expect(() => replaceBuildNumberInAppJson(RAW, '1.2.3')).toThrow(/纯数字串/);
  });
});
