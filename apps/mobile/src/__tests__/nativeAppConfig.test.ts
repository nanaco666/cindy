import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('mobile native app config', () => {
  it('keeps production dynamic config identical to app.json and only renames beta', () => {
    const appJson = JSON.parse(readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'));
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));
    const previousVariant = process.env.EXPO_PUBLIC_APP_VARIANT;
    const previousBetaDev = process.env.EXPO_PUBLIC_BETA_DEV;

    try {
      delete process.env.EXPO_PUBLIC_APP_VARIANT;
      delete process.env.EXPO_PUBLIC_BETA_DEV;
      expect(buildConfig()).toEqual(appJson.expo);
      expect(buildConfig({})).toEqual(appJson.expo);
      expect(buildConfig({ config: appJson.expo })).toEqual(appJson.expo);

      process.env.EXPO_PUBLIC_APP_VARIANT = 'beta';
      process.env.EXPO_PUBLIC_BETA_DEV = 'dash';
      expect(buildConfig({}).name).toBe('XDMaker Beta (dash)');
    } finally {
      if (previousVariant === undefined) delete process.env.EXPO_PUBLIC_APP_VARIANT;
      else process.env.EXPO_PUBLIC_APP_VARIANT = previousVariant;
      if (previousBetaDev === undefined) delete process.env.EXPO_PUBLIC_BETA_DEV;
      else process.env.EXPO_PUBLIC_BETA_DEV = previousBetaDev;
    }
  });

  it('supports iPad and phone landscape from the native shell', () => {
    const appJson = JSON.parse(readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'));
    const phoneOrientations = appJson.expo.ios.infoPlist.UISupportedInterfaceOrientations;
    const tabletOrientations = appJson.expo.ios.infoPlist['UISupportedInterfaceOrientations~ipad'];

    expect(appJson.expo.orientation).toBe('default');
    expect(appJson.expo.ios.supportsTablet).toBe(true);
    expect(phoneOrientations).toContain('UIInterfaceOrientationLandscapeLeft');
    expect(phoneOrientations).toContain('UIInterfaceOrientationLandscapeRight');
    expect(tabletOrientations).toContain('UIInterfaceOrientationLandscapeLeft');
    expect(tabletOrientations).toContain('UIInterfaceOrientationLandscapeRight');
  });

  it('declares Feishu app schemes and versions native builds from app.json', () => {
    const appJson = JSON.parse(readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'));
    const eas = JSON.parse(readFileSync(resolve(process.cwd(), 'eas.json'), 'utf8'));
    const schemes = appJson.expo.ios.infoPlist.LSApplicationQueriesSchemes;
    const buildNumber = appJson.expo.ios.buildNumber;

    // Source of truth: app.json declares the Feishu/Lark query schemes and the build number.
    expect(appJson.expo.scheme).toBe('lizcn');
    expect(schemes).toContain('feishu');
    expect(schemes).toContain('lark');
    expect(buildNumber).toMatch(/^\d{10}$/);
    expect(appJson.expo.android.versionCode).toBeUndefined();
    // appVersionSource=local makes EAS inject app.json's buildNumber into the native project's
    // CFBundleVersion + CURRENT_PROJECT_VERSION at build time. We assert that invariant here
    // rather than the gitignored, EAS-only-synced generated ios/ (plain `expo prebuild` leaves
    // CURRENT_PROJECT_VERSION=1, so asserting it against a local prebuild is unsound).
    expect(eas.cli.appVersionSource).toBe('local');
    expect(eas.build['beta-dash'].channel).toBe('beta-dash');
    expect(eas.build['beta-dash'].extends).toBe('beta-base');
    for (const profile of ['testflight', 'production', 'adhoc', 'beta-base']) {
      expect(eas.build[profile].env.EXPO_PUBLIC_XDT_NATIVE_FEISHU_LOGIN_ENABLED).toBe('1');
    }
    expect(appJson.expo.plugins).not.toContain('expo-status-bar');
    expect(appJson.expo.plugins).toContainEqual([
      'xdt-feishu-login/plugin',
      { registerCallbackScheme: true },
    ]);

    // The generated ios/ is gitignored and only present after a prebuild; when it exists it must
    // carry the Feishu schemes that prebuild copies from app.json.
    const infoPlistPath = resolve(process.cwd(), 'ios/XDMaker/Info.plist');
    if (existsSync(infoPlistPath)) {
      const infoPlist = readFileSync(infoPlistPath, 'utf8');
      expect(infoPlist).toContain('<key>LSApplicationQueriesSchemes</key>');
      expect(infoPlist).toContain('<string>feishu</string>');
      expect(infoPlist).toContain('<string>lark</string>');
    }
  });

  it('keeps Metro React resolution on the mobile app dependency', () => {
    const metroConfig = readFileSync(resolve(process.cwd(), 'metro.config.js'), 'utf8');

    expect(metroConfig).toContain("react: path.join(appNodeModules, 'react')");
    expect(metroConfig).not.toContain("react: path.join(workspaceNodeModules, 'react')");
  });

  it('wires the native Feishu Login SDK module and config plugin', () => {
    const pluginSource = readFileSync(resolve(process.cwd(), 'modules/xdt-feishu-login/plugin/index.js'), 'utf8');
    const iosPodspec = readFileSync(resolve(process.cwd(), 'modules/xdt-feishu-login/ios/XdtFeishuLogin.podspec'), 'utf8');
    const moduleConfig = readFileSync(resolve(process.cwd(), 'modules/xdt-feishu-login/expo-module.config.json'), 'utf8');
    const iosSubscriber = readFileSync(
      resolve(process.cwd(), 'modules/xdt-feishu-login/ios/XdtFeishuLoginAppDelegateSubscriber.swift'),
      'utf8',
    );
    const androidModule = readFileSync(
      resolve(process.cwd(), 'modules/xdt-feishu-login/android/src/main/java/com/xdtmaker/feishulogin/XdtFeishuLoginModule.kt'),
      'utf8',
    );
    const androidAarPath = resolve(process.cwd(), 'modules/xdt-feishu-login/android/libs/larksso-3.0.10.aar');

    // LarkSSOSDK 1.2.0 resolves from the CocoaPods trunk CDN; the volcengine-specs source must
    // NOT be injected (same pod+version on both sources triggers a fatal duplicate-spec conflict
    // in EAS clean builds). Guard both: trunk present, volcengine absent.
    expect(pluginSource).toContain("source 'https://cdn.cocoapods.org/'");
    expect(pluginSource).not.toContain("source 'https://github.com/volcengine/volcengine-specs.git'");
    expect(pluginSource).toContain('CFBundleURLTypes');
    expect(pluginSource).toContain('registerCallbackScheme');
    expect(pluginSource).toContain('process.env.EXPO_PUBLIC_FEISHU_APP_ID');
    expect(pluginSource).toContain('requires EXPO_PUBLIC_FEISHU_APP_ID');
    expect(pluginSource).toContain("replace(/_/g, '')");
    expect(pluginSource).toContain("'android:scheme': 'lark'");
    expect(pluginSource).toContain("'android:host': 'ssoclient'");
    expect(pluginSource).toContain("'android:launchMode': 'singleTop'");
    expect(pluginSource).toContain("'android:exported': 'true'");
    expect(iosPodspec).toContain("s.dependency 'LarkSSOSDK', '1.2.0'");
    expect(moduleConfig).toContain('XdtFeishuLoginAppDelegateSubscriber');
    expect(iosSubscriber).toContain('LarkSSO.handleURL(url)');
    expect(androidModule).toContain('com.ss.android.larksso.LarkSSO');
    expect(androidModule).toContain('setChallengeMode(false)');
    expect(androidModule).toContain('OnNewIntent');
    expect(androidModule).toContain('OnActivityResult');
    expect(existsSync(androidAarPath)).toBe(true);
  });
});
