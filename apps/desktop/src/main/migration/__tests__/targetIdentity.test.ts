import { describe, expect, it } from 'vitest';

import { CINDY_TARGET_BRAND, resolveTargetPaths } from '../targetIdentity';

describe('resolveTargetPaths', () => {
  it('Windows 安装路径与 exe 使用机器名 cindy', () => {
    expect(resolveTargetPaths(CINDY_TARGET_BRAND, {
      platform: 'win32',
      appDataDir: 'C:\\Users\\u\\AppData\\Roaming',
      localAppDataDir: 'C:\\Users\\u\\AppData\\Local',
    })).toEqual({
      installDir: 'C:\\Users\\u\\AppData\\Local\\Programs\\cindy',
      userDataDir: 'C:\\Users\\u\\AppData\\Roaming\\Cindy',
      exeName: 'cindy.exe',
    });
  });

  it('macOS bundle 使用展示名，Mach-O 使用 packager executableName', () => {
    expect(resolveTargetPaths(CINDY_TARGET_BRAND, {
      platform: 'darwin',
      appDataDir: '/Users/u/Library/Application Support',
      localAppDataDir: '',
    })).toEqual({
      installDir: '/Applications/Cindy.app',
      userDataDir: '/Users/u/Library/Application Support/Cindy',
      exeName: 'cindy',
    });
  });
});
