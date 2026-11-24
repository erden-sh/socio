# Socio's local Expo module (../README.md). Autolinking finds it in
# apps/mobile/modules, with no package.json of its own.
Pod::Spec.new do |s|
  s.name           = 'SocioDevice'
  s.version        = '0.1.0'
  s.summary        = 'Backup exclusion, file protection, protected-data state and process start time for Socio.'
  s.description    = s.summary
  s.license        = 'MIT'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  # The app's deployment target (app.config.ts).
  s.platforms      = { :ios => '17.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.swift'
end
