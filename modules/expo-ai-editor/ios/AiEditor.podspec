Pod::Spec.new do |s|
  s.name = 'AiEditor'
  s.version = '0.0.0'
  s.summary = 'On-device passage selection for the Pulse editing experiment'
  s.description = 'Local Expo module using the Apple Intelligence system language model. No cloud model or app-managed model downloads.'
  s.author = 'Pulse'
  s.homepage = 'https://docs.expo.dev/modules/'
  s.platforms = { :ios => '16.4' }
  s.source = { git: '' }
  s.static_framework = true
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
  s.weak_frameworks = 'FoundationModels'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.swift'
end
