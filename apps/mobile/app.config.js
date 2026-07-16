// 动态 Expo config —— region 是 app 身份、auth-server 与 OAuth 回调 scheme 的统一构建开关。
//
// - 默认 cn:com.xd.cindycn + cindycn://auth;显式 global:com.xd.cindy + cindy://auth。
// - beta 只改显示名,不改变所选 region 的身份。
// - production / TestFlight 必须由发布环境注入对应 App Store 数字 ID,缺失即中止。
// - 自建分发变体(`EXPO_PUBLIC_XDT_OTA_SELFHOST=1`,详见 docs/self-hosted-ios-build-and-ota.md):
//     · 自建线 app 身份(iOS `com.xd.cindycn` / Android `com.xd.cindycn`,2026-07-16 起,与 EAS 线
//       的 com.xd.lizcn 分离);iOS 与 Android 是两条独立自建线,bundleId / package
//       各自维护、不共用同一常量(否则改一端会静默改另一端);当前两端取值同为 com.xd.cindycn,
//       仍分开两个常量,以便任一端未来单独调整时不影响另一端。
//     · updates.url 指向 mobile-update-server 的 /manifest(自托管 JS 热更);
//     · 保留 region scheme,但使用自建 bundle identity。此变体有意改变指纹,
//       但只在该 env 开启时生效,EAS 路径仍逐字节不变。
// - 不注入任何按 commit 变化的内容(如 git hash),避免 fingerprint 每次提交漂移。
const appJson = require('./app.json');

// iOS 自建线 bundleId,须与 release-ios-local.mjs 的 SELFHOST_BUNDLE_ID 一致。
const SELFHOST_IOS_BUNDLE_ID = 'com.xd.cindycn';
// Android 自建线 package,须与 release-android-local.mjs 的 SELFHOST_PACKAGE /
// release-android-npkg.sh 的 EXPECT_PACKAGE 一致。
const SELFHOST_ANDROID_PACKAGE = 'com.xd.cindycn';

const REGION_CONFIG = {
  cn: {
    scheme: 'cindycn',
    iosBundleIdentifier: 'com.xd.cindycn',
    androidPackage: 'com.xd.cindycn',
  },
  global: {
    scheme: 'cindy',
    iosBundleIdentifier: 'com.xd.cindy',
    androidPackage: 'com.xd.cindy',
  },
};

function resolveRegion() {
  const region = process.env.EXPO_PUBLIC_CINDY_AUTH_REGION?.trim() || 'cn';
  if (region !== 'cn' && region !== 'global') {
    throw new Error(
      `EXPO_PUBLIC_CINDY_AUTH_REGION must be cn or global, got: ${region}`,
    );
  }
  return region;
}

function resolveAppStoreId(region) {
  const regionKey =
    region === 'cn' ? 'CINDY_CN_APP_STORE_ID' : 'CINDY_GLOBAL_APP_STORE_ID';
  const value = (process.env[regionKey] || '').trim();
  const requiresId =
    process.env.XDT_REQUIRE_APP_STORE_ID === '1' ||
    [
      'production',
      'testflight',
      'production-global',
      'testflight-global',
    ].includes(process.env.EAS_BUILD_PROFILE || '');
  if (requiresId && !/^\d+$/.test(value)) {
    throw new Error(
      `Missing numeric ${regionKey} for ${region} App Store build`,
    );
  }
  return value;
}

function withNativeAuthPlugins(plugins, env) {
  const next = [...plugins];
  if (env.googleIosUrlScheme) {
    next.push([
      '@react-native-google-signin/google-signin',
      { iosUrlScheme: env.googleIosUrlScheme },
    ]);
  }
  if (env.wechatAppId && env.wechatUniversalLink) {
    next.push([
      'xdt-wechat-login/plugin',
      { appId: env.wechatAppId, universalLink: env.wechatUniversalLink },
    ]);
  }
  return next;
}

module.exports = (context = {}) => {
  const baseConfig = context.config ?? appJson.expo;
  const region = resolveRegion();
  const regional = REGION_CONFIG[region];
  resolveAppStoreId(region);
  let next = {
    ...baseConfig,
    scheme: regional.scheme,
    ios: {
      ...baseConfig.ios,
      bundleIdentifier: regional.iosBundleIdentifier,
      usesAppleSignIn: true,
    },
    android: {
      ...baseConfig.android,
      package: regional.androidPackage,
    },
    plugins: withNativeAuthPlugins(baseConfig.plugins || [], {
      googleIosUrlScheme:
        process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME?.trim(),
      wechatAppId: process.env.EXPO_PUBLIC_CINDY_WECHAT_APP_ID?.trim(),
      wechatUniversalLink:
        process.env.EXPO_PUBLIC_CINDY_WECHAT_UNIVERSAL_LINK?.trim(),
    }),
    extra: {
      ...baseConfig.extra,
      cindy: {
        authRegion: region,
      },
    },
  };

  if (process.env.EXPO_PUBLIC_APP_VARIANT === 'beta') {
    const betaDev = process.env.EXPO_PUBLIC_BETA_DEV?.trim();
    const suffix = betaDev ? ` Beta (${betaDev})` : ' Beta';
    next = { ...next, name: `${next.name}${suffix}` };
  }

  // 自建门控用 EXPO_PUBLIC_XDT_OTA_SELFHOST(而非仅 URL 存在):同一个 EXPO_PUBLIC 标志既在此
  // 决定换 bundleId / updates.url,又被 inline 进 JS 供运行时 IS_OTA_SELFHOST 判定,构建与运行时严格对齐。
  if (process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST === '1') {
    const base = process.env.EXPO_PUBLIC_XDT_OTA_URL?.trim().replace(/\/+$/, '');
    // Android 自建线:versionCode 只在此自建分支注入(经 release-android-*.mjs 传入的
    // XDT_ANDROID_VERSION_CODE),APK 覆盖安装 + NPKG md5 去重要求它单调递增。app.json 里
    // **不声明** android.versionCode → 非自建 resolved config 逐字节不变(红线 1,EAS 指纹不受影响)。
    // 值来源是 committed android-version.json,由发布脚本读取并置入 env,app.config.js 不直接读文件
    // (避免把版本文件卷进 @expo/fingerprint 的配置源)。缺省(非 Android 出包路径)则不注入。
    const rawVersionCode = process.env.XDT_ANDROID_VERSION_CODE?.trim();
    const versionCode = rawVersionCode ? Number(rawVersionCode) : undefined;
    next = {
      ...next,
      ios: { ...next.ios, bundleIdentifier: SELFHOST_IOS_BUNDLE_ID },
      android: {
        ...next.android,
        package: SELFHOST_ANDROID_PACKAGE,
        ...(Number.isInteger(versionCode) && versionCode > 0 ? { versionCode } : {}),
      },
      updates: {
        ...next.updates,
        // base 缺省时保留原 url,避免打出指向空地址的包;真实发版必须提供 EXPO_PUBLIC_XDT_OTA_URL。
        ...(base ? { url: `${base}/manifest` } : {}),
      },
    };
  }

  return next;
};
