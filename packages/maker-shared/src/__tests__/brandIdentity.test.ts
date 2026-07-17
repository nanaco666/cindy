import { describe, expect, it } from 'vitest';
import { BRAND_NAME } from '../branding.js';
import {
  BRAND_IDENTITY,
  DEFAULT_CINDY_REGION,
  allDeepLinkSchemes,
  allUserDataDirNames,
  brandAppId,
  brandBundleIdPrefix,
  resolveCindyRegion,
} from '../brandIdentity.js';

/**
 * brand-identity 是标识符层单点,消费方(forge / main 常量 / release 脚本)
 * 对格式有硬约束。这里锁住形状与不变量,防止改名/改值时把非法字符或自相
 * 矛盾的配置带上线——这类错误 typecheck 拦不住,只有到 OS 注册/更新链路
 * 运行时才爆炸。
 */
describe('BRAND_IDENTITY invariants', () => {
  it('displayName 与 branding.ts 的 BRAND_NAME 同源', () => {
    expect(BRAND_IDENTITY.displayName).toBe(BRAND_NAME);
  });

  it('cdnPrefix / dbFilePrefix / updaterName 是安全的小写文件名段', () => {
    // 要进 OSS key(大小写敏感)与文件路径,统一小写规避平台差异。
    const fileSafe = /^[a-z0-9][a-z0-9-]*$/;
    expect(BRAND_IDENTITY.cdnPrefix).toMatch(fileSafe);
    expect(BRAND_IDENTITY.dbFilePrefix).toMatch(fileSafe);
    for (const prefix of BRAND_IDENTITY.legacyDbFilePrefixes) {
      expect(prefix).toMatch(fileSafe);
    }
    expect(BRAND_IDENTITY.updaterName).toMatch(fileSafe);
  });

  it('executableName / userDataDirName 是安全的文件名段(允许首字母大写)', () => {
    // executableName 首字母大写是产品决策(Cindy.exe,同 Discord/Slack 惯例):
    // Windows 进程匹配大小写不敏感,mac Mach-O 名对用户不可见;OSS key 等大小写
    // 敏感场景一律走小写的 cdnPrefix,不用本字段。userDataDirName 同理
    // (Electron productName 惯例)。
    const dirSafe = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
    expect(BRAND_IDENTITY.executableName).toMatch(dirSafe);
    expect(BRAND_IDENTITY.userDataDirName).toMatch(dirSafe);
    for (const dir of BRAND_IDENTITY.legacyUserDataDirNames) {
      expect(dir).toMatch(dirSafe);
    }
  });

  it('scheme 符合 RFC 3986(字母开头,字母/数字/+/-/. 组成)且主 scheme 不在 legacy 里', () => {
    const schemeRe = /^[a-z][a-z0-9+.-]*$/;
    expect(BRAND_IDENTITY.primaryScheme).toMatch(schemeRe);
    for (const s of BRAND_IDENTITY.legacySchemes) {
      expect(s).toMatch(schemeRe);
    }
    expect(BRAND_IDENTITY.legacySchemes).not.toContain(BRAND_IDENTITY.primaryScheme);
  });

  it('appId 两区都是反向域名格式且互不相同(cn/global 可并存的系统身份)', () => {
    const rdnRe = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;
    expect(BRAND_IDENTITY.appIdByRegion.cn).toMatch(rdnRe);
    expect(BRAND_IDENTITY.appIdByRegion.global).toMatch(rdnRe);
    expect(BRAND_IDENTITY.appIdByRegion.cn).not.toBe(BRAND_IDENTITY.appIdByRegion.global);
  });

  it('legacy userData / DB 前缀不含当前值(历史表只放旧值)', () => {
    expect(BRAND_IDENTITY.legacyUserDataDirNames).not.toContain(
      BRAND_IDENTITY.userDataDirName,
    );
    expect(BRAND_IDENTITY.legacyDbFilePrefixes).not.toContain(
      BRAND_IDENTITY.dbFilePrefix,
    );
  });

  it('身份翻转后 legacy 数组必须携带 xdt-maker 旧值(兼容锚,只增不减)', () => {
    expect(BRAND_IDENTITY.legacySchemes).toContain('xdt-maker');
    expect(BRAND_IDENTITY.legacyUserDataDirNames).toContain('xdt-maker');
    expect(BRAND_IDENTITY.legacyDbFilePrefixes).toContain('xdt-maker');
  });

  it('档案与内嵌数组已冻结,消费方无法运行时篡改', () => {
    expect(Object.isFrozen(BRAND_IDENTITY)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.appIdByRegion)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.legacySchemes)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.legacyUserDataDirNames)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.legacyDbFilePrefixes)).toBe(true);
  });
});

describe('区域解析与派生', () => {
  it('resolveCindyRegion:空值 → 默认 cn;合法值归一化;非法值抛错', () => {
    expect(resolveCindyRegion(undefined)).toBe('cn');
    expect(resolveCindyRegion(null)).toBe('cn');
    expect(resolveCindyRegion('')).toBe('cn');
    expect(resolveCindyRegion('  ')).toBe('cn');
    expect(resolveCindyRegion('cn')).toBe('cn');
    expect(resolveCindyRegion('global')).toBe('global');
    expect(resolveCindyRegion('GLOBAL')).toBe('global');
    expect(() => resolveCindyRegion('us')).toThrow(/Invalid Cindy region/);
  });

  it('brandAppId / brandBundleIdPrefix 按区域取值,默认 cn', () => {
    expect(DEFAULT_CINDY_REGION).toBe('cn');
    expect(brandAppId()).toBe('com.xd.cindycn');
    expect(brandAppId('global')).toBe('com.xd.cindy');
    expect(brandBundleIdPrefix('cn')).toBe('com.xd.cindycn');
    expect(brandBundleIdPrefix('global')).toBe('com.xd.cindy');
  });
});

describe('派生 helper', () => {
  it('allDeepLinkSchemes 主 scheme 恒为首位且包含全部 legacy', () => {
    expect(allDeepLinkSchemes()).toEqual(['cindy', 'xdt-maker']);
  });

  it('allUserDataDirNames 当前目录名恒为首位且包含全部历史值', () => {
    expect(allUserDataDirNames()).toEqual(['Cindy', 'xdt-maker']);
  });

  it('helper 接受显式档案参数(历史身份回放用)', () => {
    const legacyLike = {
      ...BRAND_IDENTITY,
      primaryScheme: 'xdt-maker',
      legacySchemes: [],
      userDataDirName: 'xdt-maker',
      legacyUserDataDirNames: [],
      dbFilePrefix: 'xdt-maker',
      legacyDbFilePrefixes: [],
    };
    expect(allDeepLinkSchemes(legacyLike)).toEqual(['xdt-maker']);
    expect(allUserDataDirNames(legacyLike)).toEqual(['xdt-maker']);
  });
});
