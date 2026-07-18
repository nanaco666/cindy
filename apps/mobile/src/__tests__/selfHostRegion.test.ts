// @ts-nocheck —— 被测对象是 .mjs 发布工具模块,vitest 跑其纯函数。
import { describe, expect, it } from 'vitest';
import {
  SELF_HOST_REGIONS,
  validateSelfHostRegions,
  resolveSelfHostRegion,
  regionEnvSuffix,
  regionEnvOverrides,
  formatSelfHostReleaseCommand,
  assertRegionOssComplete,
  stripSelfHostTapdbEnv,
} from '../../scripts/lib/self-host-region.mjs';

// 一份结构完整的合法配置(oss/signing 叶子值都填,供 resolve/override/assert 用例复用)。
const VALID = {
  cn: {
    authRegion: 'cn',
    iosBundleId: 'com.xd.cindycn',
    androidPackage: 'com.xd.cindycn',
    npkgExpectBundle: 'com.xd.cindycn',
    tapdb: { clientId: 'tap-client', clientToken: 'tap-token' },
    oss: { cdnBaseUrl: 'https://cdn.cn/x', bucket: 'b-cn', prefix: 'p', ossRegion: 'oss-cn-shanghai' },
    iosSigning: { teamId: 'T', profileName: 'P', signIdentity: 'I', profilePath: '' },
    androidSigning: { keyAlias: 'a', keystorePath: '/k.jks' },
  },
  global: {
    authRegion: 'global',
    iosBundleId: 'com.xd.cindy',
    androidPackage: 'com.xd.cindy',
    npkgExpectBundle: 'com.xd.cindy',
    tapdb: { clientId: 'tap-client', clientToken: 'tap-token' },
    oss: { cdnBaseUrl: 'https://cdn.app/x', bucket: 'b-g', prefix: 'p', ossRegion: 'oss-ap' },
    iosSigning: { teamId: 'T2', profileName: 'P2', signIdentity: 'I2', profilePath: '' },
    androidSigning: { keyAlias: 'ag', keystorePath: '/kg.jks' },
  },
};

const clone = () => JSON.parse(JSON.stringify(VALID));

describe('SELF_HOST_REGIONS', () => {
  it('只认 cn / global', () => {
    expect([...SELF_HOST_REGIONS]).toEqual(['cn', 'global']);
  });
});

describe('validateSelfHostRegions', () => {
  it('结构完整 → 返回冻结的 { cn, global }', () => {
    const r = validateSelfHostRegions(clone());
    expect(r.cn.iosBundleId).toBe('com.xd.cindycn');
    expect(r.global.androidPackage).toBe('com.xd.cindy');
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.cn.tapdb)).toBe(true);
    expect(Object.isFrozen(r.cn.oss)).toBe(true);
  });
  it('非对象 / 缺 region 块 → 抛错', () => {
    expect(() => validateSelfHostRegions(null)).toThrow(/必须是 JSON object/);
    const noGlobal = clone();
    delete noGlobal.global;
    expect(() => validateSelfHostRegions(noGlobal)).toThrow(/缺少 region 配置块: global/);
  });
  it('authRegion 与 key 不一致 → 抛错', () => {
    const bad = clone();
    bad.cn.authRegion = 'global';
    expect(() => validateSelfHostRegions(bad)).toThrow(/cn\.authRegion 必须等于/);
  });
  it('身份字段为空 → 抛错', () => {
    const bad = clone();
    bad.cn.iosBundleId = '';
    expect(() => validateSelfHostRegions(bad)).toThrow(/cn\.iosBundleId 必须是非空字符串/);
  });
  it('TapDB 公开配置缺失或为空 → 抛错', () => {
    const missing = clone();
    delete missing.cn.tapdb;
    expect(() => validateSelfHostRegions(missing)).toThrow(/cn\.tapdb 必须是 object/);
    const empty = clone();
    empty.global.tapdb.clientToken = '';
    expect(() => validateSelfHostRegions(empty)).toThrow(/global\.tapdb\.clientToken 必须是非空字符串/);
  });
  it('oss 叶子值允许留空(dry-run 未配置态),但键必须存在', () => {
    const dryRun = clone();
    dryRun.cn.oss = { cdnBaseUrl: '', bucket: '', prefix: '', ossRegion: '' };
    expect(() => validateSelfHostRegions(dryRun)).not.toThrow();
    const missingKey = clone();
    missingKey.cn.oss = { cdnBaseUrl: '', bucket: '', prefix: '' }; // 缺 ossRegion
    expect(() => validateSelfHostRegions(missingKey)).toThrow(/cn\.oss\.ossRegion/);
  });
});

describe('stripSelfHostTapdbEnv', () => {
  it('清掉 ambient TapDB 注入键,保留其它构建环境', () => {
    const env = stripSelfHostTapdbEnv({
      EXPO_PUBLIC_TAPTAP_CLIENT_ID: 'ambient-id',
      EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN: 'ambient-token',
      EXPO_PUBLIC_TAPDB_CHANNEL: 'ambient-channel',
      EXPO_PUBLIC_TAPDB_REGION: 'global',
      EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
    });
    expect(env).toEqual({ EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn' });
  });
});

describe('resolveSelfHostRegion（--region 必填,不 fallback）', () => {
  it('缺 --region → 抛错', () => {
    expect(() => resolveSelfHostRegion({}, { regions: VALID })).toThrow(/必须显式指定 --region/);
    expect(() => resolveSelfHostRegion({ region: '  ' }, { regions: VALID })).toThrow(/必须显式指定 --region/);
  });
  it('非法 --region → 抛错', () => {
    expect(() => resolveSelfHostRegion({ region: 'us' }, { regions: VALID })).toThrow(/只能是/);
  });
  it('合法 --region → 返回对应块', () => {
    expect(resolveSelfHostRegion({ region: 'global' }, { regions: VALID }).iosBundleId).toBe('com.xd.cindy');
    expect(resolveSelfHostRegion({ region: 'cn' }, { regions: VALID }).authRegion).toBe('cn');
  });
});

describe('regionEnvSuffix / regionEnvOverrides', () => {
  it('后缀是 authRegion 大写', () => {
    expect(regionEnvSuffix(VALID.cn)).toBe('CN');
    expect(regionEnvSuffix(VALID.global)).toBe('GLOBAL');
  });
  it('非空 oss → 覆盖 XDT_OSS_*;空值不覆盖', () => {
    const ov = regionEnvOverrides(VALID.global, {});
    expect(ov.XDT_CDN_BASE_URL).toBe('https://cdn.app/x');
    expect(ov.XDT_OSS_BUCKET).toBe('b-g');
    const empty = { ...VALID.cn, oss: { cdnBaseUrl: '', bucket: '', prefix: '', ossRegion: '' } };
    expect(regionEnvOverrides(empty, {})).not.toHaveProperty('XDT_OSS_BUCKET');
  });
  it('AK/SK 带 region 后缀时覆盖 FP_DEV_*;缺省不覆盖(走现有一套)', () => {
    const withKeys = regionEnvOverrides(VALID.global, {
      XDT_OSS_ACCESS_KEY_ID_GLOBAL: 'akg',
      XDT_OSS_ACCESS_KEY_SECRET_GLOBAL: 'skg',
    });
    expect(withKeys.FP_DEV_OSS_ACCESS_KEY_ID).toBe('akg');
    expect(withKeys.FP_DEV_OSS_ACCESS_KEY_SECRET).toBe('skg');
    expect(regionEnvOverrides(VALID.cn, {})).not.toHaveProperty('FP_DEV_OSS_ACCESS_KEY_ID');
  });
});

describe('formatSelfHostReleaseCommand', () => {
  it('把当前 region 带进自建线后续命令', () => {
    expect(formatSelfHostReleaseCommand('ios', 'local', VALID.global, { execute: true }))
      .toBe('pnpm mobile:release:ios:local -- --region global --execute');
    expect(formatSelfHostReleaseCommand('android', 'ota', VALID.cn, { execute: true }))
      .toBe('pnpm mobile:release:android:ota -- --region cn --execute');
  });

  it('不允许无效平台、操作或 region', () => {
    expect(() => formatSelfHostReleaseCommand('windows', 'local', VALID.cn)).toThrow(/平台/);
    expect(() => formatSelfHostReleaseCommand('ios', 'publish', VALID.cn)).toThrow(/操作/);
    expect(() => formatSelfHostReleaseCommand('ios', 'local', 'us')).toThrow(/region/);
  });
});

describe('assertRegionOssComplete', () => {
  it('完整 → 通过;有空项 → 抛错点名', () => {
    expect(() => assertRegionOssComplete(VALID.cn)).not.toThrow();
    const partial = { ...VALID.cn, oss: { cdnBaseUrl: 'https://x/y', bucket: '', prefix: 'p', ossRegion: '' } };
    expect(() => assertRegionOssComplete(partial)).toThrow(/bucket, ossRegion/);
  });
});
