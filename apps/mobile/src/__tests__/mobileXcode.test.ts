// @ts-nocheck —— 被测对象是 .mjs 开发工具模块，vitest 跑其纯函数。
import { describe, expect, it } from 'vitest';
import {
  parseMobileXcodeArgs,
  selectMobileXcodeWorkspace,
  updateMobileXcodeEnvContent,
} from '../../scripts/lib/mobile-xcode.mjs';

describe('mobile:xcode 参数', () => {
  it('支持 --region value / --region=value 与 pnpm 的分隔符', () => {
    expect(parseMobileXcodeArgs(['--region', 'cn'])).toEqual({ help: false, region: 'cn' });
    expect(parseMobileXcodeArgs(['--', '--region=global'])).toEqual({ help: false, region: 'global' });
  });

  it('region 必填且只允许 cn / global', () => {
    expect(() => parseMobileXcodeArgs([])).toThrow(/必须显式指定/);
    expect(() => parseMobileXcodeArgs(['--region', 'us'])).toThrow(/只能是 cn 或 global/);
    expect(() => parseMobileXcodeArgs(['--region'])).toThrow(/必须显式指定/);
  });
});

describe('mobile:xcode env 切换', () => {
  it('覆盖地区键、去掉重复定义并保留其它本地配置', () => {
    const source = [
      '# local settings',
      'EXPO_PUBLIC_CINDY_AUTH_REGION=cn',
      'EXPO_PUBLIC_CINDY_AUTH_REGION=stale',
      'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=https://cn.example',
      'EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID=keep-me',
      '',
    ].join('\n');
    const next = updateMobileXcodeEnvContent(source, {
      EXPO_PUBLIC_CINDY_AUTH_REGION: 'global',
      EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://global.example',
    });

    expect(next.match(/EXPO_PUBLIC_CINDY_AUTH_REGION=/g)).toHaveLength(1);
    expect(next).toContain('EXPO_PUBLIC_CINDY_AUTH_REGION=global');
    expect(next).toContain('EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=https://global.example');
    expect(next).toContain('EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID=keep-me');
  });
});

describe('mobile:xcode workspace 选择', () => {
  it('只选 app workspace，忽略 Pods workspace', () => {
    expect(selectMobileXcodeWorkspace('/repo/apps/mobile/ios', [
      'Pods.xcworkspace',
      'Cindy.xcworkspace',
      'Podfile',
    ])).toBe('/repo/apps/mobile/ios/Cindy.xcworkspace');
  });

  it('缺失或出现多个 app workspace 时 fail closed', () => {
    expect(() => selectMobileXcodeWorkspace('/ios', ['Podfile'])).toThrow(/未在 .* 找到/);
    expect(() => selectMobileXcodeWorkspace('/ios', ['A.xcworkspace', 'B.xcworkspace'])).toThrow(/找到多个/);
  });
});
