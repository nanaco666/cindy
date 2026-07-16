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
end
