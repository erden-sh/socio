# Socio's local Expo module (../README.md). Autolinking finds it in
# apps/mobile/modules, with no package.json of its own.
Pod::Spec.new do |s|
  s.name           = 'SocioGoogleSignIn'
  s.version        = '0.1.0'
  s.summary        = "Google's own sign-in (GoogleSignIn) for Socio's Google sign-in, an ID token only."
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
  # Google's sign-in SDK (README.md lists what it brings).
  s.dependency 'GoogleSignIn', '~> 9.0'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.swift'
end
