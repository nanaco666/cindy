const { withPodfile } = require("@expo/config-plugins");

// XdtWechatLogin(package.json 依赖,expo autolinking 无条件装 pod)靠手写 modulemap 让 Swift
// `import WechatOpenSDK`(腾讯 SDK 是纯 ObjC 静态库,自身不带 modulemap)。clang 解析 modulemap
// 里 `header "WXApi.h"` 这类相对路径时只认 modulemap 自身所在目录,-I / -Xcc -I 一概不参与
// (2026-07 archive 实测:编译命令带着 -Xcc -I$(PODS_ROOT)/WechatOpenSDK/OpenSDK2.0.5 仍报
// header not found)。所以 modulemap 必须物理落在 SDK 头文件旁边;Podfile 由 expo prebuild
// 重新生成,这份拷贝逻辑只能注入 post_install 才能在每次 prebuild / pod install 后存活。
// podspec 侧配套:XdtWechatLogin.podspec 的 SWIFT_INCLUDE_PATHS 指向同一目录。
// 注意:必须无条件注册(区别于按 env 门控的 xdt-wechat-login/plugin)——只要 pod 装了
// WechatOpenSDK,XdtWechatLogin 的 Swift 编译就依赖这份 modulemap,与微信登录是否启用无关。
const HOOK_MARKER = "xdt-wechat-login: WechatOpenSDK modulemap";
const HOOK = `
    # ${HOOK_MARKER}(clang 只按 modulemap 所在目录解析 header 相对路径,拷到 SDK 头文件旁)
    require 'fileutils'
    wechat_mm = File.expand_path('../../modules/xdt-wechat-login/ios/WechatOpenSDK/module.modulemap', installer.sandbox.root.to_s)
    wechat_headers = Dir[File.join(installer.sandbox.root.to_s, 'WechatOpenSDK', '*', 'WXApi.h')]
    raise 'xdt-wechat-login: Pods/WechatOpenSDK 下未找到 WXApi.h,无法落位 module.modulemap(SDK 目录布局变了?)' if wechat_headers.empty?
    wechat_headers.each do |header|
      FileUtils.cp(wechat_mm, File.join(File.dirname(header), 'module.modulemap'))
    end
`;

module.exports = function withWechatOpenSdkModulemap(config) {
  return withPodfile(config, (podfileConfig) => {
    let contents = podfileConfig.modResults.contents;
    if (!contents.includes(HOOK_MARKER)) {
      if (!/post_install do \|installer\|/.test(contents)) {
        throw new Error(
          "with-wechat-opensdk-modulemap: Podfile 未找到 post_install 块,无法注入 WechatOpenSDK modulemap 拷贝",
        );
      }
      contents = contents.replace(
        /post_install do \|installer\|/,
        `post_install do |installer|${HOOK}`,
      );
      podfileConfig.modResults.contents = contents;
    }
    return podfileConfig;
  });
};
