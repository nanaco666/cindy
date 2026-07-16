require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'XdtTapdb'
  s.version        = package['version']
  s.summary        = 'TapDB mobile analytics bridge for XDMaker mobile.'
  s.description    = 'Expo module that initializes TapTapSDK Core TapDB analytics for XDMaker mobile.'
  s.license        = 'UNLICENSED'
  s.author         = 'XDMaker'
  s.homepage       = 'https://xdt-maker.local'
  s.platforms      = {
    :ios => '15.1'
  }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://xdt-maker.local/xdt-maker.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'TapTapSDK/Core', '4.10.5'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
