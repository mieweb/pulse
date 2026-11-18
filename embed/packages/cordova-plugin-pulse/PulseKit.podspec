# PulseKit's xcframeworks for cordova-plugin-pulse (plugin.xml points the host's Podfile here).
#
# TEMPLATE: the release workflow replaces the URL and SHA-256 placeholders below with the
# release archive's, which holds every *.xcframework at its top level. Until then only the
# development source below works.
#
# Development: PULSEKIT_LOCAL=<folder of *.xcframework> (or a .zip of them) builds against a local
# PulseKit. A folder is zipped into the system temp folder, again whenever a framework in it is
# newer than that zip.

require 'digest'
require 'tmpdir'

PULSEKIT_RELEASE_URL = '__PULSEKIT_ZIP_URL__'
PULSEKIT_RELEASE_SHA256 = '__PULSEKIT_ZIP_SHA256__'

def pulsekit_source
  local = ENV.fetch('PULSEKIT_LOCAL', '')
  return { :http => PULSEKIT_RELEASE_URL, :sha256 => PULSEKIT_RELEASE_SHA256 } if local.empty?

  path = File.expand_path(local)
  return { :http => "file://#{path}" } if File.file?(path)

  frameworks = Dir.exist?(path) ? Dir.children(path).select { |n| n.end_with?('.xcframework') }.sort : []
  raise "PULSEKIT_LOCAL=#{path} holds no .xcframework" if frameworks.empty?

  zip = File.join(Dir.tmpdir, "pulsekit-local-#{Digest::SHA256.hexdigest(path)[0, 12]}.zip")
  newest = frameworks.map { |n| File.mtime(File.join(path, n)) }.max
  unless File.exist?(zip) && File.mtime(zip) >= newest
    File.delete(zip) if File.exist?(zip)
    Dir.chdir(path) { system('zip', '-qry', zip, *frameworks) || raise("Couldn't zip #{path}") }
  end
  { :http => "file://#{zip}" }
end

Pod::Spec.new do |s|
  s.name = 'PulseKit'
  # Lockstep with the embed packages; the release workflow stamps it.
  s.version = '0.0.0-dev'
  s.summary = 'Pulse, the video recorder and editor, as frameworks a host app presents.'
  s.homepage = 'https://github.com/mieweb/pulse'
  s.author = 'mieweb'
  s.source = pulsekit_source
  # Capacitor's floor; Pulse's own (iOS 16.4, iPhone) is checked at run time by info().supported.
  s.platform = :ios, '15.0'
  s.vendored_frameworks = '*.xcframework'
end
