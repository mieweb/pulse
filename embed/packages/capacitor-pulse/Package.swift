// swift-tools-version: 5.9
import Foundation
import PackageDescription

// @mieweb/capacitor-pulse: the Capacitor transport over PulseKit (native-bridge.md §7.1).
//
// PulseKit ships as a set of xcframeworks, each a binary target here:
// - Release: remote zips. This file is a placeholder until the release workflow writes
//   the real URLs and checksums; the placeholder targets can't resolve.
// - Development: PULSEKIT_LOCAL=<folder of *.xcframework> uses that folder instead, e.g. the
//   output of embed/scripts/package-ios.mjs. A relative folder is taken from this package's root.
//   SwiftPM accepts only paths relative to the package root, so the folder is rewritten relative
//   to it. Xcode reads the variable only when it was started with it (or from xcodebuild).
//
// .iOS(.v15) because Capacitor's CapApp-SPM declares 15; Pulse's floor (iOS 16.4, iPhone) is
// enforced at run time by info().supported.

/// The xcframeworks of the M1 build. The release workflow regenerates this file from the real list.
let releaseFrameworks = [
  "ExpoBrownfield", "ExpoFont", "ExpoImage", "ExpoMediaLibrary", "ExpoModulesCore",
  "ExpoModulesJSI", "ExpoModulesWorklets", "ExpoVideo", "PulseKit", "React",
  "ReactNativeDependencies", "SDWebImage", "SDWebImageAVIFCoder", "SDWebImageSVGCoder",
  "SDWebImageWebPCoder", "hermesvm", "libavif", "rnwhisper",
]
let releaseBase = "https://github.com/mieweb/pulse/releases/download/pulsekit-v0.0.0-dev"
let placeholderChecksum = String(repeating: "0", count: 64)

let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().standardizedFileURL

/// `target` relative to `base`, with `..` where it leaves it (both absolute, standardized).
func relativePath(from base: URL, to target: URL) -> String {
  let from = base.pathComponents
  let to = target.pathComponents
  var shared = 0
  while shared < from.count, shared < to.count, from[shared] == to[shared] { shared += 1 }
  let up = Array(repeating: "..", count: from.count - shared)
  let path = (up + to[shared...]).joined(separator: "/")
  return path.isEmpty ? "." : path
}

func binaryTargets() -> [Target] {
  let env = ProcessInfo.processInfo.environment["PULSEKIT_LOCAL"] ?? ""
  if env.isEmpty {
    return releaseFrameworks.map {
      .binaryTarget(
        name: $0, url: "\(releaseBase)/\($0).xcframework.zip", checksum: placeholderChecksum)
    }
  }
  let folder = URL(fileURLWithPath: env, relativeTo: packageRoot).absoluteURL.standardizedFileURL
  let found = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
  let names = found.filter { $0.hasSuffix(".xcframework") }.map { String($0.dropLast(12)) }.sorted()
  // An empty or missing folder keeps the release names, so the error names the expected paths.
  let local = relativePath(from: packageRoot, to: folder)
  return (names.isEmpty ? releaseFrameworks : names).map {
    .binaryTarget(name: $0, path: "\(local)/\($0).xcframework")
  }
}

let binaries = binaryTargets()

let package = Package(
  name: "MiewebCapacitorPulse",
  platforms: [.iOS(.v15)],
  products: [
    // Capacitor's CLI names the product after the npm package: @mieweb/capacitor-pulse.
    .library(name: "MiewebCapacitorPulse", targets: ["PulsePlugin"])
  ],
  dependencies: [
    .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
  ],
  targets: binaries + [
    .target(
      name: "PulsePlugin",
      dependencies: [.product(name: "Capacitor", package: "capacitor-swift-pm")]
        + binaries.map { .target(name: $0.name) },
      path: "ios/Sources/PulsePlugin"
    )
  ]
)
