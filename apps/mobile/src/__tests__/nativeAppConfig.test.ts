import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const managedEnvKeys = [
  'CINDY_CN_APP_STORE_ID',
  'CINDY_GLOBAL_APP_STORE_ID',
  'EAS_BUILD_PROFILE',
  'EXPO_PUBLIC_APP_VARIANT',
  'EXPO_PUBLIC_BETA_DEV',
  'EXPO_PUBLIC_CINDY_AUTH_REGION',
  'EXPO_PUBLIC_XDT_OTA_SELFHOST',
  'EXPO_PUBLIC_XDT_OTA_URL',
  'CINDY_SELF_HOST_REGIONS_FILE',
];
let previousEnv: Record<string, string | undefined>;
const temporaryDirs: string[] = [];

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
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
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
      'Cindy Beta (dash)',
    );
  });

  it('self-host builds use endpoint-driven OTA without baking the update server URL', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));

    const regular = buildConfig({ config: appJson.expo });
    expect(regular.updates).toEqual(appJson.expo.updates);

    const configDir = mkdtempSync(join(tmpdir(), 'cindy-selfhost-regions-'));
    temporaryDirs.push(configDir);
    const regionsPath = join(configDir, 'regions.json');
    writeFileSync(regionsPath, JSON.stringify({
      cn: {
        iosBundleId: 'com.xd.cindycn',
        androidPackage: 'com.xd.cindycn',
        tapdb: { clientId: 'json-id', clientToken: 'json-token' },
      },
      global: {
        iosBundleId: 'com.xd.cindy',
        androidPackage: 'com.xd.cindy',
        tapdb: { clientId: 'json-id', clientToken: 'json-token' },
      },
    }));
    process.env.CINDY_SELF_HOST_REGIONS_FILE = regionsPath;
    process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST = '1';
    // 即使调用环境残留旧变量,自建原生 config 也不得再消费真实更新地址。
    process.env.EXPO_PUBLIC_XDT_OTA_URL = 'https://must-not-be-baked.example.com';
    const selfHosted = buildConfig({ config: appJson.expo });
    expect(selfHosted.updates).toMatchObject({
      url: 'https://selfhost.invalid/manifest',
      checkAutomatically: 'NEVER',
      disableAntiBrickingMeasures: true,
    });
    expect(JSON.stringify(selfHosted)).not.toContain('must-not-be-baked.example.com');
    // 自建 app 身份按 region 从 self-host-regions.json(.example 回落)取,而非写死。
    expect(selfHosted.ios.bundleIdentifier).toBe('com.xd.cindycn');
    expect(selfHosted.android.package).toBe('com.xd.cindycn');
    expect(selfHosted.extra.cindy.tapdb).toEqual({
      clientId: 'json-id',
      clientToken: 'json-token',
      region: 'cn',
    });

    process.env.EXPO_PUBLIC_CINDY_AUTH_REGION = 'global';
    const selfHostedGlobal = buildConfig({ config: appJson.expo });
    expect(selfHostedGlobal.ios.bundleIdentifier).toBe('com.xd.cindy');
    expect(selfHostedGlobal.android.package).toBe('com.xd.cindy');
    expect(selfHostedGlobal.extra.cindy.tapdb.region).toBe('global');
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

  it('Metro nodeModulesPaths 覆盖 workspace TS 源码包各自的 node_modules(pnpm hoisted 布局下 workspace: 链接不提升到根,只在消费方包自己的 node_modules)', () => {
    // 2026-07-16 iOS 冷更实踩:disableHierarchicalLookup 后漏列这些目录,
    // packages/device-link 引用的 @cindy/device-link-protocol(cindy-protocol submodule)
    // 在 expo export:embed 打 bundle 时 Unable to resolve → ARCHIVE FAILED。
    // 期望路径从 metro.config.js 自身位置推导(它内部用 __dirname 计算),不依赖测试进程 cwd。
    const metroConfigPath = require.resolve('../../metro.config.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const metroConfig = require(metroConfigPath);
    const appDir = dirname(metroConfigPath);
    const paths: string[] = metroConfig.resolver.nodeModulesPaths;
    // path.join 产物在 Windows 上是反斜杠,比较前统一归一为 POSIX 分隔符(规则 15)。
    const posix = (p: string) => p.split(sep).join('/');
    for (const packageName of ['auth-client', 'device-link', 'maker-shared', 'model-providers']) {
      expect(paths.some((p) => posix(p).endsWith(`packages/${packageName}/node_modules`))).toBe(true);
    }
    // 追加在 app / workspace 根之后:常规依赖命中顺序不变(精确断言前两位,防止顺序被换)。
    expect(paths[0]).toBe(join(appDir, 'node_modules'));
    expect(paths[1]).toBe(join(resolve(appDir, '../..'), 'node_modules'));
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
    const iosWechatPodfilePlugin = readFileSync(
      resolve(process.cwd(), 'plugins/with-wechat-opensdk-modulemap.js'),
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
    expect(iosCoordinator).toContain('#if targetEnvironment(simulator)');
    expect(iosCoordinator).toContain('ERR_WECHAT_UNAVAILABLE_ON_SIMULATOR');
    expect(iosWechatPodfilePlugin).toContain(
      'xdt-wechat-login: arm64 simulator stub linkage',
    );
    expect(iosWechatPodfilePlugin).toContain(
      "other_linker_flags[:libraries].delete?('WechatOpenSDK')",
    );
    expect(iosWechatPodfilePlugin).toContain(
      "OTHER_LDFLAGS[sdk=iphoneos*]",
    );
    expect(iosSubscriber).toContain('continue userActivity: NSUserActivity');
  });

  it('independently injects the WeChat simulator hook into an existing Podfile', () => {
    const plugin = require(
      resolve(process.cwd(), 'plugins/with-wechat-opensdk-modulemap.js'),
    ) as {
      injectPostInstallHooks(contents: string): string;
    };
    const oldPodfile = `
post_install do |installer|
  # xdt-wechat-login: WechatOpenSDK modulemap
  # xdt-wechat-login: arm64 simulator stub linkage
end
`;

    const upgradedPodfile = plugin.injectPostInstallHooks(oldPodfile);
    expect(upgradedPodfile.match(/WechatOpenSDK modulemap/g)).toHaveLength(1);
    expect(upgradedPodfile).toContain(
      'xdt-wechat-login: arm64 simulator stub linkage v2',
    );
    expect(upgradedPodfile.match(/arm64 simulator stub linkage v2/g)).toHaveLength(1);
    expect(plugin.injectPostInstallHooks(upgradedPodfile)).toBe(upgradedPodfile);
  });
});
