require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'XdtIosAppDistribution'
  s.version        = package['version']
  s.summary        = 'iOS App Store distribution environment bridge for Cindy mobile.'
  s.description    = 'Expo module that exposes the verified StoreKit app transaction environment to JavaScript.'
  s.license        = 'UNLICENSED'
  s.author         = 'XDMaker'
  s.homepage       = 'https://xdt-maker.local'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://xdt-maker.local/xdt-maker.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'StoreKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = '**/*.{h,m,swift}'
end
