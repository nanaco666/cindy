require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'XdtFeishuLogin'
  s.version        = package['version']
  s.summary        = 'Feishu native Login SDK bridge for XDMaker mobile.'
  s.description    = 'Expo module that wraps Feishu LarkSSOSDK authorization code login for XDMaker mobile.'
  s.license        = 'UNLICENSED'
  s.author         = 'XDMaker'
  s.homepage       = 'https://xdt-maker.local'
  s.platforms      = {
    :ios => '16.4'
  }
  # 显式钉 Swift 5 语言模式(canonical '5.0'):SDK 56 / Xcode 26 工具链若把工程默认拉到 Swift 6
  # 严格并发,会对 pendingPromise 等共享可变状态报数据竞争错误。Swift 6 并发改造留 follow-up。
  s.swift_version  = '5.0'
  s.source         = { git: 'https://xdt-maker.local/xdt-maker.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'LarkSSOSDK', '1.2.0'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
