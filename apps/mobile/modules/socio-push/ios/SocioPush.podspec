# Socio's local Expo module for push (../README.md). Autolinking finds it in
# apps/mobile/modules, with no package.json of its own. Shared/ is plain Swift
# that the notification service extension compiles too; Package.swift and
# Tests/ are for `swift test` on the Mac, not part of the pod.
Pod::Spec.new do |s|
  s.name           = 'SocioPush'
  s.version        = '0.1.0'
  s.summary        = 'Web Push keys, the decryptor and the extension inbox for Socio.'
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
  s.source_files = 'Module/**/*.swift', 'Shared/**/*.swift'
end
