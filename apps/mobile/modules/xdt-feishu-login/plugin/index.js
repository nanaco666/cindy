const { AndroidConfig, createRunOncePlugin, withAndroidManifest, withInfoPlist, withPodfile } = require('@expo/config-plugins');

const PACKAGE_NAME = 'xdt-feishu-login';

function normalizeAppScheme(appId) {
  return String(appId).replace(/_/g, '');
}

function withFeishuLogin(config, options = {}) {
  const appId = String(process.env.EXPO_PUBLIC_FEISHU_APP_ID || '').trim();
  if (!appId) {
    throw new Error('xdt-feishu-login requires EXPO_PUBLIC_FEISHU_APP_ID');
  }
  const scheme = normalizeAppScheme(appId);
  const registerCallbackScheme = options.registerCallbackScheme !== false;
  config = withFeishuInfoPlist(config, scheme, registerCallbackScheme);
  config = withFeishuPodfileSource(config);
  config = withFeishuAndroidManifest(config, scheme, registerCallbackScheme);
  return config;
}

function withFeishuInfoPlist(config, scheme, registerCallbackScheme) {
  return withInfoPlist(config, (config) => {
    const infoPlist = config.modResults;
    infoPlist.LSApplicationQueriesSchemes = unique([...(infoPlist.LSApplicationQueriesSchemes || []), 'lark', 'feishu']);
    if (!registerCallbackScheme) return config;
    const urlTypes = Array.isArray(infoPlist.CFBundleURLTypes) ? infoPlist.CFBundleURLTypes : [];
    const hasScheme = urlTypes.some((entry) => Array.isArray(entry.CFBundleURLSchemes) && entry.CFBundleURLSchemes.includes(scheme));
    if (!hasScheme) {
      urlTypes.push({
        CFBundleURLName: scheme,
        CFBundleURLSchemes: [scheme],
      });
    }
    infoPlist.CFBundleURLTypes = urlTypes;
    return config;
  });
}

function withFeishuPodfileSource(config) {
  return withPodfile(config, (config) => {
    // LarkSSOSDK 1.2.0 在 CocoaPods 官方公共 CDN(trunk)上就有,只需保证 trunk 源存在即可解析。
    // 不要再注入 volcengine-specs 源:该 pod 在 trunk 与 volcengine-specs 上同名同版本同时存在,
    // 两个源并列会触发 `Found multiple specifications for LarkSSOSDK (1.2.0)` 冲突(本地仅 warning、
    // EAS 干净环境致命),且 EAS 还需现 clone 巨型 volcengine-specs 仓库——这正是 EAS prebuild 阶段
    // pod install 失败、iOS 构建 ERRORED 的根因。仅保留 trunk,二者皆免。
    const trunk = "source 'https://cdn.cocoapods.org/'";
    let contents = config.modResults.contents;
    if (!contents.includes(trunk)) {
      contents = `${trunk}\n${contents}`;
    }
    config.modResults.contents = contents;
    return config;
  });
}

function withFeishuAndroidManifest(config, scheme, registerCallbackScheme) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    ensureAndroidQueries(manifest);
    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(config.modResults);
    mainActivity.$ = {
      ...mainActivity.$,
      'android:launchMode': 'singleTop',
      'android:exported': 'true',
    };
    if (!registerCallbackScheme) return config;
    mainActivity['intent-filter'] = mainActivity['intent-filter'] || [];
    if (!hasIntentFilterForScheme(mainActivity['intent-filter'], scheme)) {
      mainActivity['intent-filter'].push({
        action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
        category: [
          { $: { 'android:name': 'android.intent.category.DEFAULT' } },
          { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
        ],
        data: [{ $: { 'android:scheme': scheme } }],
      });
    }
    return config;
  });
}

function ensureAndroidQueries(manifest) {
  manifest.queries = manifest.queries || [];
  const queries = manifest.queries;
  const hasLarkQuery = queries.some((query) =>
    (query.intent || []).some((intent) =>
      (intent.data || []).some((data) => data.$?.['android:scheme'] === 'lark' && data.$?.['android:host'] === 'ssoclient')));
  if (!hasLarkQuery) {
    queries.push({
      intent: [{
        action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
        data: [{ $: { 'android:scheme': 'lark', 'android:host': 'ssoclient' } }],
      }],
    });
  }
}

function hasIntentFilterForScheme(filters, scheme) {
  return filters.some((filter) => (filter.data || []).some((data) => data.$?.['android:scheme'] === scheme));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

module.exports = createRunOncePlugin(withFeishuLogin, PACKAGE_NAME, '0.1.0');
