import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const managedEnvKeys = [
  'CINDY_CN_APP_STORE_ID',
  'CINDY_GLOBAL_APP_STORE_ID',
  'EAS_BUILD_PROFILE',
  'EXPO_PUBLIC_APP_VARIANT',
  'EXPO_PUBLIC_BETA_DEV',
  'EXPO_PUBLIC_CINDY_AUTH_REGION',
];
let previousEnv: Record<string, string | undefined>;

beforeEach(() => {
  previousEnv = Object.fromEntries(
    managedEnvKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of managedEnvKeys) delete process.env[key];
});

afterEach(() => {
  for (const key of managedEnvKeys) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('mobile native app config', () => {
  it('defaults to the CN app identity and requires an explicit Global build', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));

    const cn = buildConfig({ config: appJson.expo });
    expect(cn.scheme).toBe('cindycn');
    expect(cn.ios.bundleIdentifier).toBe('com.xd.cindycn');
    expect(cn.android.package).toBe('com.xd.cindycn');
    expect(cn.extra.cindy.authRegion).toBe('cn');

    process.env.EXPO_PUBLIC_CINDY_AUTH_REGION = 'global';
    const global = buildConfig({ config: appJson.expo });
    expect(global.scheme).toBe('cindy');
    expect(global.ios.bundleIdentifier).toBe('com.xd.cindy');
    expect(global.android.package).toBe('com.xd.cindy');
    expect(global.extra.cindy.authRegion).toBe('global');

    process.env.EXPO_PUBLIC_APP_VARIANT = 'beta';
    process.env.EXPO_PUBLIC_BETA_DEV = 'dash';
    expect(buildConfig({ config: appJson.expo }).name).toBe(
      'XDMaker Beta (dash)',
    );
  });

  it('fails closed when a store build lacks its regional App Store numeric ID', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));

    process.env.EAS_BUILD_PROFILE = 'production';
    expect(() => buildConfig({ config: appJson.expo })).toThrow(
      'CINDY_CN_APP_STORE_ID',
    );
    process.env.CINDY_CN_APP_STORE_ID = '1234567890';
    expect(buildConfig({ config: appJson.expo }).extra.cindy).toEqual({
      authRegion: 'cn',
    });

    process.env.EAS_BUILD_PROFILE = 'production-global';
    process.env.EXPO_PUBLIC_CINDY_AUTH_REGION = 'global';
    delete process.env.CINDY_CN_APP_STORE_ID;
    expect(() => buildConfig({ config: appJson.expo })).toThrow(
      'CINDY_GLOBAL_APP_STORE_ID',
    );
    process.env.CINDY_GLOBAL_APP_STORE_ID = '9876543210';
    expect(buildConfig({ config: appJson.expo }).extra.cindy).toEqual({
      authRegion: 'global',
    });
  });

  it('supports iPad and phone landscape and versions native builds from app.json', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const eas = JSON.parse(
      readFileSync(resolve(process.cwd(), 'eas.json'), 'utf8'),
    );
    const phoneOrientations =
      appJson.expo.ios.infoPlist.UISupportedInterfaceOrientations;
    const tabletOrientations =
      appJson.expo.ios.infoPlist['UISupportedInterfaceOrientations~ipad'];

    expect(appJson.expo.orientation).toBe('default');
    expect(appJson.expo.ios.supportsTablet).toBe(true);
    expect(phoneOrientations).toContain('UIInterfaceOrientationLandscapeLeft');
    expect(phoneOrientations).toContain('UIInterfaceOrientationLandscapeRight');
    expect(tabletOrientations).toContain('UIInterfaceOrientationLandscapeLeft');
    expect(tabletOrientations).toContain(
      'UIInterfaceOrientationLandscapeRight',
    );
    expect(appJson.expo.ios.buildNumber).toMatch(/^\d{10}$/);
    expect(appJson.expo.android.versionCode).toBeUndefined();
    expect(eas.cli.appVersionSource).toBe('local');
    expect(eas.build.production.extends).toBe('store-cn-base');
    expect(eas.build['production-global'].extends).toBe('store-global-base');
  });

  it('keeps Metro React resolution on the mobile app dependency', () => {
    const metroConfig = readFileSync(
      resolve(process.cwd(), 'metro.config.js'),
      'utf8',
    );
    expect(metroConfig).toContain("react: path.join(appNodeModules, 'react')");
    expect(metroConfig).not.toContain("react: path.join(workspaceNodeModules, 'react')");
    expect(metroConfig).toContain("'auth-client'");
    expect(metroConfig).toContain("'@cindy/device-link-protocol'");
  });

  it('wires first-party Apple, public Google, and the minimal official WeChat bridge', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    const configSource = readFileSync(
      resolve(process.cwd(), 'app.config.js'),
      'utf8',
    );
    const pluginSource = readFileSync(
      resolve(process.cwd(), 'modules/xdt-wechat-login/plugin/index.js'),
      'utf8',
    );
    const iosPodspec = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/ios/XdtWechatLogin.podspec',
      ),
      'utf8',
    );
    const androidGradle = readFileSync(
      resolve(process.cwd(), 'modules/xdt-wechat-login/android/build.gradle'),
      'utf8',
    );
    const moduleConfig = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/expo-module.config.json',
      ),
      'utf8',
    );
    const iosCoordinator = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/ios/XdtWechatAuthCoordinator.swift',
      ),
      'utf8',
    );
    const iosSubscriber = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/ios/XdtWechatLoginAppDelegateSubscriber.swift',
      ),
      'utf8',
    );

    expect(appJson.expo.ios.usesAppleSignIn).toBe(true);
    expect(appJson.expo.plugins).toContain('expo-apple-authentication');
    expect(packageJson.dependencies['expo-apple-authentication']).toBeTruthy();
    expect(
      packageJson.dependencies['@react-native-google-signin/google-signin'],
    ).toBe('16.1.2');
    expect(packageJson.dependencies['xdt-wechat-login']).toBe(
      'file:./modules/xdt-wechat-login',
    );
    expect(
      existsSync(
        resolve(
          process.cwd(),
          'modules/xdt-feishu-login/expo-module.config.json',
        ),
      ),
    ).toBe(false);
    expect(configSource).toContain(
      "'@react-native-google-signin/google-signin'",
    );
    expect(configSource).toContain("'xdt-wechat-login/plugin'");
    expect(pluginSource).toContain("'weixinULAPI'");
    expect(pluginSource).toContain("'.wxapi.WXEntryActivity'");
    expect(pluginSource).toContain('withWechatEntryActivity(config, appId)');
    expect(pluginSource).toContain('createWXAPI(this, ${kotlinAppId}, false)');
    expect(iosPodspec).toContain("s.dependency 'WechatOpenSDK', '2.0.5'");
    expect(androidGradle).toContain('wechat-sdk-android:6.8.38');
    expect(moduleConfig).toContain('XdtWechatLoginAppDelegateSubscriber');
    expect(iosCoordinator).toContain(
      'WXApi.handleOpenUniversalLink(userActivity, delegate: self)',
    );
    expect(iosSubscriber).toContain('continue userActivity: NSUserActivity');
  });
});
