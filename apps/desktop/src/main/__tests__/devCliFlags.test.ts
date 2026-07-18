import { describe, expect, it } from 'vitest';

import { resolveDevCliFlags } from '../devCliFlags';

const base = {
  argv: ['electron', '.'] as readonly string[],
  isPackaged: false,
  envUserDataDir: undefined as string | undefined,
  defaultUserDataDir: '/AppData/xdt-maker',
  envIsolated: undefined as string | undefined,
  envIsolationName: undefined as string | undefined,
  envDeviceIdOverride: undefined as string | undefined,
  envEndpointsCdn: undefined as string | undefined,
};

describe('resolveDevCliFlags', () => {
  it('无参数无 env = 原行为(不覆写、不被动、不派生设备标识)', () => {
    expect(resolveDevCliFlags(base)).toEqual({
      schedulerPassive: false,
      userDataDirOverride: null,
      needsIsolatedDeviceId: false,
      isolationName: null,
      invalidIsolationName: null,
      endpointsCdn: false,
    });
  });

  it('--passive 只开被动,不动 userData / 设备标识', () => {
    const flags = resolveDevCliFlags({ ...base, argv: [...base.argv, '--passive'] });
    expect(flags.schedulerPassive).toBe(true);
    expect(flags.userDataDirOverride).toBeNull();
    expect(flags.needsIsolatedDeviceId).toBe(false);
  });

  it('--isolated 默认沙箱:目录 <userData>-dev,要求派生设备标识,无名字', () => {
    const flags = resolveDevCliFlags({ ...base, argv: [...base.argv, '--isolated'] });
    expect(flags.userDataDirOverride).toBe('/AppData/xdt-maker-dev');
    expect(flags.needsIsolatedDeviceId).toBe(true);
    expect(flags.isolationName).toBeNull();
  });

  it('--isolated=<名字> 命名沙箱:目录 <userData>-dev-<名字>,带出名字', () => {
    const flags = resolveDevCliFlags({ ...base, argv: [...base.argv, '--isolated=feature-a'] });
    expect(flags.userDataDirOverride).toBe('/AppData/xdt-maker-dev-feature-a');
    expect(flags.needsIsolatedDeviceId).toBe(true);
    expect(flags.isolationName).toBe('feature-a');
    expect(flags.invalidIsolationName).toBeNull();
  });

  it('--isolated=<非法名字> 回落默认沙箱并带出非法名(不回落到不隔离)', () => {
    const bad = resolveDevCliFlags({ ...base, argv: [...base.argv, '--isolated=我的沙箱'] });
    expect(bad.userDataDirOverride).toBe('/AppData/xdt-maker-dev');
    expect(bad.needsIsolatedDeviceId).toBe(true);
    expect(bad.isolationName).toBeNull();
    expect(bad.invalidIsolationName).toBe('我的沙箱');
    // 超长(33 字符)同样非法
    const long = resolveDevCliFlags({ ...base, argv: [...base.argv, `--isolated=${'a'.repeat(33)}`] });
    expect(long.invalidIsolationName).toBe('a'.repeat(33));
    expect(long.userDataDirOverride).toBe('/AppData/xdt-maker-dev');
  });

  it('XDT_ISOLATED=1(restart 脚本默认沙箱路径)等价 --isolated', () => {
    const flags = resolveDevCliFlags({ ...base, envIsolated: '1' });
    expect(flags.userDataDirOverride).toBe('/AppData/xdt-maker-dev');
    expect(flags.needsIsolatedDeviceId).toBe(true);
    expect(flags.isolationName).toBeNull();
  });

  it('XDT_ISOLATED=1 + XDT_ISOLATED_NAME(restart 脚本命名沙箱路径)等价 --isolated=<名字>', () => {
    const flags = resolveDevCliFlags({ ...base, envIsolated: '1', envIsolationName: 'feature-b' });
    expect(flags.userDataDirOverride).toBe('/AppData/xdt-maker-dev-feature-b');
    expect(flags.isolationName).toBe('feature-b');
  });

  it('名叫 "1" 的沙箱不与开关标记值撞车(codex review P2 回归)', () => {
    // argv 路径
    const viaArgv = resolveDevCliFlags({ ...base, argv: [...base.argv, '--isolated=1'] });
    expect(viaArgv.isolationName).toBe('1');
    expect(viaArgv.userDataDirOverride).toBe('/AppData/xdt-maker-dev-1');
    // restart env 路径:开关与名字分离,名字 '1' 原样生效
    const viaEnv = resolveDevCliFlags({ ...base, envIsolated: '1', envIsolationName: '1' });
    expect(viaEnv.isolationName).toBe('1');
    expect(viaEnv.userDataDirOverride).toBe('/AppData/xdt-maker-dev-1');
  });

  it('XDT_ISOLATED 开关严格等于 "1" 才生效("0"/"false"/名字串都视为关)', () => {
    for (const v of ['0', 'false', 'true', 'feature-b']) {
      const flags = resolveDevCliFlags({ ...base, envIsolated: v });
      expect(flags.userDataDirOverride).toBeNull();
      expect(flags.needsIsolatedDeviceId).toBe(false);
    }
  });

  it('env 名字非法时回落默认沙箱并带出非法名', () => {
    const flags = resolveDevCliFlags({ ...base, envIsolated: '1', envIsolationName: '我的沙箱' });
    expect(flags.userDataDirOverride).toBe('/AppData/xdt-maker-dev');
    expect(flags.invalidIsolationName).toBe('我的沙箱');
  });

  it('argv 的隔离意图优先于 env(两条入口同时给时不混合)', () => {
    const flags = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated=from-argv'],
      envIsolated: '1',
      envIsolationName: 'from-env',
    });
    expect(flags.isolationName).toBe('from-argv');
  });

  it('空白 XDT_USER_DATA_DIR 视作未设置:--isolated 回落默认沙箱目录', () => {
    const flags = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated'],
      envUserDataDir: '   ',
    });
    expect(flags.userDataDirOverride).toBe('/AppData/xdt-maker-dev');
  });

  it('显式 XDT_DEVICE_ID_OVERRIDE 时隔离模式不再派生设备标识', () => {
    const flags = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated=feature-a'],
      envDeviceIdOverride: 'my-device',
    });
    expect(flags.needsIsolatedDeviceId).toBe(false);
    // 空白串视作未设置,仍要派生
    const blank = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated'],
      envDeviceIdOverride: '   ',
    });
    expect(blank.needsIsolatedDeviceId).toBe(true);
  });

  it('显式 XDT_USER_DATA_DIR 优先于沙箱默认目录(设备标识照常派生)', () => {
    const flags = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--isolated=feature-a'],
      envUserDataDir: '/custom/sandbox',
    });
    expect(flags.userDataDirOverride).toBe('/custom/sandbox');
    expect(flags.needsIsolatedDeviceId).toBe(true);
  });

  it('仅设 XDT_USER_DATA_DIR(无隔离意图)沿用原语义,不派生设备标识', () => {
    // device-link 多实例联调的既有工作流:userData 与 deviceId 由用户各自显式控制。
    const flags = resolveDevCliFlags({ ...base, envUserDataDir: '/custom/sandbox' });
    expect(flags.userDataDirOverride).toBe('/custom/sandbox');
    expect(flags.needsIsolatedDeviceId).toBe(false);
  });

  it('packaged 版本一律不覆写(线上零影响)', () => {
    const flags = resolveDevCliFlags({
      ...base,
      isPackaged: true,
      argv: [...base.argv, '--passive', '--isolated=feature-a'],
      envUserDataDir: '/custom/sandbox',
      envIsolated: '1',
      envIsolationName: 'feature-b',
    });
    expect(flags).toEqual({
      schedulerPassive: false,
      userDataDirOverride: null,
      needsIsolatedDeviceId: false,
      isolationName: null,
      invalidIsolationName: null,
      endpointsCdn: false,
    });
  });

  it('--endpoints-cdn / XDT_ENDPOINTS_CDN=1 双通道(与 --passive 同款);开关非 "1" 视为关', () => {
    expect(resolveDevCliFlags({ ...base, argv: [...base.argv, '--endpoints-cdn'] }).endpointsCdn).toBe(true);
    expect(resolveDevCliFlags({ ...base, envEndpointsCdn: '1' }).endpointsCdn).toBe(true);
    for (const v of ['0', 'false', 'true', 'yes']) {
      expect(resolveDevCliFlags({ ...base, envEndpointsCdn: v }).endpointsCdn).toBe(false);
    }
    // packaged 恒 false(packaged 本来就走 CDN,该标志无意义)
    const packaged = resolveDevCliFlags({
      ...base,
      isPackaged: true,
      argv: [...base.argv, '--endpoints-cdn'],
      envEndpointsCdn: '1',
    });
    expect(packaged.endpointsCdn).toBe(false);
  });

  it('--passive 与命名沙箱可组合', () => {
    const flags = resolveDevCliFlags({
      ...base,
      argv: [...base.argv, '--passive', '--isolated=feature-a'],
    });
    expect(flags.schedulerPassive).toBe(true);
    expect(flags.userDataDirOverride).toBe('/AppData/xdt-maker-dev-feature-a');
    expect(flags.isolationName).toBe('feature-a');
  });
});
