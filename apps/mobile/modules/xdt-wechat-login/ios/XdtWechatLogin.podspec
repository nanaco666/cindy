require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'XdtWechatLogin'
  s.version        = package['version']
  s.summary        = 'Minimal WeChat authorization-code bridge for Cindy mobile.'
  s.description    = 'Expo module that requests a WeChat native login authorization code.'
  s.license        = 'UNLICENSED'
  s.author         = 'Cindy'
  s.homepage       = 'https://cindy.app'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.0'
  s.source         = { git: 'https://cindy.app/cindy.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'WechatOpenSDK', '2.0.5'
  s.source_files = '**/*.{h,m,swift}'

  # WechatOpenSDK is a pure ObjC static lib without a modulemap.
  # Provide one so Swift can `import WechatOpenSDK` under Xcode's explicit-modules mode.
  s.preserve_paths = 'WechatOpenSDK/module.modulemap'
  s.pod_target_xcconfig = {
    'SWIFT_INCLUDE_PATHS' => '$(PODS_TARGET_SRCROOT)/WechatOpenSDK',
    'HEADER_SEARCH_PATHS' => '$(PODS_ROOT)/WechatOpenSDK/OpenSDK2.0.5'
  }
end
