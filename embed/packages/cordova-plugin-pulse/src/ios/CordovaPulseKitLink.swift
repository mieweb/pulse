import Foundation

/// The plugin's only way into PulseKit (native-bridge.md §8). It calls the Objective-C names that
/// PulseKit.swift freezes, looked up at run time:
///
/// - `+[PulseKit shared]`
/// - `-[PulseKit callWithJSON:presenter:reply:]` (the whole transport)
/// - `-[PulseKit setOnEvent:]` (the one event subscriber)
///
/// So the plugin compiles without PulseKit's Swift module, and nothing ties the compiler that
/// builds the host to the one that built the xcframeworks. A host that ships the plugin without
/// PulseKit gets a transport error instead of a crash.
///
/// The Capacitor plugin (PulseKitLink.swift) and the Cordova plugin (CordovaPulseKitLink.swift)
/// each carry an identical copy of this file.
enum PulseKitLink {
  static let missing = "PulseKit isn't linked into this app."

  private typealias CallIMP = @convention(c) (
    AnyObject, Selector, NSString, AnyObject?, @escaping @convention(block) (NSString) -> Void
  ) -> Void
  private typealias SetEventIMP = @convention(c) (
    AnyObject, Selector, (@convention(block) (NSString) -> Void)?
  ) -> Void

  private static let sharedSelector = NSSelectorFromString("shared")
  private static let callSelector = NSSelectorFromString("callWithJSON:presenter:reply:")
  private static let setEventSelector = NSSelectorFromString("setOnEvent:")

  /// `PulseKit.shared`, or nil when PulseKit isn't in the app.
  static func kit() -> NSObject? {
    if NSClassFromString("PulseKit") == nil { loadEmbeddedFramework() }
    guard let type = NSClassFromString("PulseKit") as? NSObject.Type,
      type.responds(to: sharedSelector)
    else { return nil }
    return type.perform(sharedSelector)?.takeUnretainedValue() as? NSObject
  }

  /// Sends one request envelope. `reply` gets exactly one reply envelope, on the main queue.
  /// Returns false, and never calls `reply`, when PulseKit isn't there.
  @discardableResult
  static func call(
    _ json: String, presenter: AnyObject?, reply: @escaping (String) -> Void
  ) -> Bool {
    guard let kit = kit(), kit.responds(to: callSelector) else { return false }
    let fn = unsafeBitCast(kit.method(for: callSelector), to: CallIMP.self)
    fn(kit, callSelector, json as NSString, presenter) { reply($0 as String) }
    return true
  }

  /// Makes `handler` PulseKit's event subscriber (event envelopes, main queue); nil removes it.
  @discardableResult
  static func setOnEvent(_ handler: ((String) -> Void)?) -> Bool {
    guard let kit = kit(), kit.responds(to: setEventSelector) else { return false }
    let fn = unsafeBitCast(kit.method(for: setEventSelector), to: SetEventIMP.self)
    if let handler {
      fn(kit, setEventSelector) { handler($0 as String) }
    } else {
      fn(kit, setEventSelector, nil)
    }
    return true
  }

  /// The request's `method`: the plugin needs it only to keep an `open` call alive.
  static func method(of json: String) -> String? { topLevelString("method", in: json) }

  /// The event's `name`: the plugin needs it only to choose which events wait for a subscriber.
  static func eventName(of json: String) -> String? { topLevelString("name", in: json) }

  private static func topLevelString(_ key: String, in json: String) -> String? {
    guard let data = json.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return object[key] as? String
  }

  /// The linker may leave out a framework the plugin never names, so load PulseKit.framework
  /// from the app's Frameworks folder when its class isn't registered yet.
  private static func loadEmbeddedFramework() {
    guard
      let url = Bundle.main.privateFrameworksURL?.appendingPathComponent("PulseKit.framework"),
      let bundle = Bundle(url: url)
    else { return }
    _ = try? bundle.loadAndReturnError()
  }
}
