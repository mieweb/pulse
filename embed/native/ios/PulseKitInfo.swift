import Foundation
import UIKit

/// `info()` (native-bridge.md §3) and the host's Info.plist requirements (PLAN §8).
///
/// The build stamps come from PulseKit.framework's own Info.plist, which the packaging script
/// (embed/scripts/lib/plist-stamp.mjs) writes: PulseKitVersion, PulseKitBuild, PulseKitGitSha,
/// PulseKitContractMinor, PulseKitFormatVersion and PulseKitDbSchema. The purpose strings come
/// from the host app's Info.plist.
enum PulseKitInfo {
  /// iOS 16.4 is Pulse's floor (pulse-editor's minimum); iPad waits for X7.
  static func support() -> (supported: Bool, reason: String?) {
    if ProcessInfo.processInfo.isiOSAppOnMac || ProcessInfo.processInfo.isMacCatalystApp {
      return (false, "device")
    }
    guard #available(iOS 16.4, *) else { return (false, "os") }
    switch UIDevice.current.userInterfaceIdiom {
    case .phone: return (true, nil)
    case .pad: return (false, "ipad")
    default: return (false, "device")
    }
  }

  static func json(namespace: String?) -> JSONValue {
    let stamps = Bundle(for: PulseKit.self)
    func text(_ key: String, _ fallback: String) -> JSONValue {
      .string((stamps.object(forInfoDictionaryKey: key) as? String) ?? fallback)
    }
    func number(_ key: String, _ fallback: Int64) -> JSONValue {
      let raw = stamps.object(forInfoDictionaryKey: key)
      if let n = raw as? NSNumber { return .int(n.int64Value) }
      if let s = raw as? String, let n = Int64(s) { return .int(n) }
      return .int(fallback)
    }
    let support = support()
    var o: [String: JSONValue] = [
      "sdkVersion": text("PulseKitVersion", "0.0.0"),
      "build": text("PulseKitBuild", "0"),
      "gitSha": text("PulseKitGitSha", "unknown"),
      "contract": .object([
        "major": .int(Int64(PulseContract.major)),
        "minor": number("PulseKitContractMinor", Int64(PulseContract.minor)),
      ]),
      "formatVersion": number("PulseKitFormatVersion", 0),
      "dbSchema": number("PulseKitDbSchema", 0),
      "entries": .array(PulseContract.entries.map { .string($0) }),
      "methods": .array(PulseContract.nativeMethods.map { .string($0) }),
      "capabilities": .array(capabilities().map { .string($0) }),
      "platform": .string("ios"),
      "osVersion": .string(UIDevice.current.systemVersion),
      "supported": .bool(support.supported),
      "namespace": namespace.map { .string($0) } ?? .null,
    ]
    if let reason = support.reason { o["unsupportedReason"] = .string(reason) }
    return .object(o)
  }

  /// Whether host writes run Pulse JS with no screen at all (the `headless` capability, AD5).
  /// A build-time flag, OFF by default: spike S3 (a cold-launch Send from a list row merges and
  /// uploads with nothing presented, and a killed upload resumes the same way) decides on a phone
  /// whether it ships ON. While it is off, a write that finds Pulse's runtime cold presents the
  /// brief "Preparing…" screen instead (PulseKitPresenter.swift), and paused jobs wait for the
  /// host's "Tap to resume" (O2).
  ///
  /// To build with it on: `PULSEKIT_HEADLESS=1 npm run prebuild -- --platform ios` in `embed/`
  /// (plugins/with-pulsekit-facade.js adds `PULSEKIT_HEADLESS` to the PulseKit target's
  /// `SWIFT_ACTIVE_COMPILATION_CONDITIONS`), then pods and `npm run build:ios` as usual. A prebuild
  /// without it turns the flag off again. Without the plugin change, set the `#else` branch below to
  /// true. `info().capabilities` lists `headless` exactly when it is on.
  #if PULSEKIT_HEADLESS
    static let headless = true
  #else
    static let headless = false
  #endif

  /// What this build can do: Pulse's uploads go on in PulseKit's background session after Pulse
  /// closes ('upload.background', O16), and `headless` when the flag above is on. Save to Photos
  /// needs the host's NSPhotoLibraryAddUsageDescription (AD30). Not 'upload.pulse' yet: an open
  /// with uploadMode 'pulse' answers `unsupported` until flow/validate.ts accepts it (PR2-I adds
  /// the capability with it).
  static func capabilities() -> [String] {
    var list = ["upload.background", "upload.file", "share"]
    if hostHas("NSPhotoLibraryAddUsageDescription") { list.append("saveToPhotos") }
    if headless { list.append("headless") }
    return list
  }

  /// The purpose strings `open` can't do without; a host that lacks one would crash on the first
  /// camera or microphone request, so `open` refuses with `host_misconfigured` instead.
  static func missingRequiredKeys() -> [String] {
    ["NSCameraUsageDescription", "NSMicrophoneUsageDescription"].filter { !hostHas($0) }
  }

  static func hostHas(_ key: String) -> Bool {
    guard let s = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return false }
    return !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// The default hostId: the host's bundle id, sanitised (AD12).
  static func defaultHostId() -> String {
    PulseNamespace.sanitise(Bundle.main.bundleIdentifier ?? "host")
  }
}
