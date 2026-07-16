import { describe, expect, it } from 'vitest';
import { BRAND_NAME } from '../branding.js';
import {
  BRAND_IDENTITY,
  allDbFilePrefixes,
  allDeepLinkSchemes,
  allUserDataDirNames,
} from '../brandIdentity.js';

/**
 * brand-identity 是标识符层单点,消费方(forge / main 常量 / release 脚本 /
 * 迁移 manifest)对格式有硬约束。这里锁住形状与不变量,防止改名/改值时把
 * 非法字符或自相矛盾的配置带上线——这类错误 typecheck 拦不住,只有到 OS
 * 注册/更新链路运行时才爆炸。
 */
describe('BRAND_IDENTITY invariants', () => {
  it('displayName 与 branding.ts 的 BRAND_NAME 同源', () => {
    expect(BRAND_IDENTITY.displayName).toBe(BRAND_NAME);
  });

  it('executableName / userDataDirName / cdnPrefix / dbFilePrefix / updaterName 是安全的文件名段', () => {
    // 只允许小写字母、数字、连字符:要进文件路径、OSS key、进程名,任何
    // 空格 / 大小写混用 / 特殊字符都会在某个平台上炸(Windows 大小写不敏感
    // 但 OSS key 敏感,统一小写规避)。userDataDirName 例外允许首字母大写
    // (Electron productName 惯例,如未来的 "Cindy")。
    const fileSafe = /^[a-z0-9][a-z0-9-]*$/;
    const dirSafe = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
    expect(BRAND_IDENTITY.executableName).toMatch(fileSafe);
    expect(BRAND_IDENTITY.cdnPrefix).toMatch(fileSafe);
    expect(BRAND_IDENTITY.dbFilePrefix).toMatch(fileSafe);
    for (const prefix of BRAND_IDENTITY.legacyDbFilePrefixes) {
      expect(prefix).toMatch(fileSafe);
    }
    expect(BRAND_IDENTITY.updaterName).toMatch(fileSafe);
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

  it('appId / bundleIdPrefix 是反向域名格式', () => {
    const rdnRe = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;
    expect(BRAND_IDENTITY.appId).toMatch(rdnRe);
    expect(BRAND_IDENTITY.bundleIdPrefix).toMatch(rdnRe);
  });

  it('legacy userData / DB 前缀不含当前值(历史表只放旧值)', () => {
    expect(BRAND_IDENTITY.legacyUserDataDirNames).not.toContain(
      BRAND_IDENTITY.userDataDirName,
    );
    expect(BRAND_IDENTITY.legacyDbFilePrefixes).not.toContain(
      BRAND_IDENTITY.dbFilePrefix,
    );
  });

  it('档案与内嵌数组已冻结,消费方无法运行时篡改', () => {
    expect(Object.isFrozen(BRAND_IDENTITY)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.legacySchemes)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.legacyUserDataDirNames)).toBe(true);
    expect(Object.isFrozen(BRAND_IDENTITY.legacyDbFilePrefixes)).toBe(true);
  });
});

describe('派生 helper', () => {
  it('allDeepLinkSchemes 主 scheme 恒为首位且包含全部 legacy', () => {
    const all = allDeepLinkSchemes();
    expect(all[0]).toBe(BRAND_IDENTITY.primaryScheme);
    expect(all).toHaveLength(1 + BRAND_IDENTITY.legacySchemes.length);
  });

  it('allUserDataDirNames 当前目录名恒为首位且包含全部历史值', () => {
    const all = allUserDataDirNames();
    expect(all[0]).toBe(BRAND_IDENTITY.userDataDirName);
    expect(all).toHaveLength(1 + BRAND_IDENTITY.legacyUserDataDirNames.length);
  });

  it('allDbFilePrefixes 当前前缀恒为首位并去重历史值', () => {
    expect(allDbFilePrefixes({
      ...BRAND_IDENTITY,
      dbFilePrefix: 'cindy',
      legacyDbFilePrefixes: ['xdt-maker', 'cindy'],
    })).toEqual(['cindy', 'xdt-maker']);
  });

  it('helper 接受显式档案参数(迁移 manifest 生成用)', () => {
    const cindyLike = {
      ...BRAND_IDENTITY,
      primaryScheme: 'cindy',
      legacySchemes: ['xdt-maker'],
      userDataDirName: 'Cindy',
      legacyUserDataDirNames: ['xdt-maker'],
      dbFilePrefix: 'cindy',
      legacyDbFilePrefixes: ['xdt-maker'],
    };
    expect(allDeepLinkSchemes(cindyLike)).toEqual(['cindy', 'xdt-maker']);
    expect(allUserDataDirNames(cindyLike)).toEqual(['Cindy', 'xdt-maker']);
    expect(allDbFilePrefixes(cindyLike)).toEqual(['cindy', 'xdt-maker']);
  });
});
