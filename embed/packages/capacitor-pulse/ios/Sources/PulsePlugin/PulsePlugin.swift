import Capacitor
import Foundation

/// Capacitor transport for PulseKit (native-bridge.md §7.1). It holds no Pulse logic:
///
/// - `call({ json })` passes one request envelope to PulseKit and resolves `{ json }` with the
///   reply envelope. The JSON stays a string, so Capacitor's value bridging can't change numbers or
///   nulls. A Pulse error is a resolved reply with `ok: false`; the promise rejects only when the
///   transport fails (no `json` string, or PulseKit isn't linked).
/// - `addListener('event', cb)` delivers `{ json }` event envelopes. `flowResult` and
///   `hostRequest` wait for a listener (`retainUntilConsumed`), so a page that reloads still gets
///   them; the others don't, because the client re-reads the catalog after it subscribes.
/// - `open` replies when the flow ends, minutes later, so its call stays saved until then.
@objc(PulsePlugin)
public class PulsePlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "PulsePlugin"
  public let jsName = "Pulse"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise)
  ]

  private static let retainedEvents: Set<String> = ["flowResult", "hostRequest"]

  override public func load() {
    let linked = PulseKitLink.setOnEvent { [weak self] json in self?.forward(json) }
    if !linked { NSLog("[Pulse] %@ Every call will be rejected.", PulseKitLink.missing) }
  }

  @objc func call(_ call: CAPPluginCall) {
    guard let json = call.getString("json") else {
      return call.reject("Pulse.call needs { json: string }.")
    }
    let opens = PulseKitLink.method(of: json) == "open"
    DispatchQueue.main.async { [weak self] in
      let bridge = self?.bridge
      if opens {
        call.keepAlive = false
        bridge?.saveCall(call)
      }
      let sent = PulseKitLink.call(json, presenter: bridge?.viewController) { reply in
        call.resolve(["json": reply])
        if opens { bridge?.releaseCall(call) }
      }
      if !sent {
        if opens { bridge?.releaseCall(call) }
        call.reject(PulseKitLink.missing)
      }
    }
  }

  private func forward(_ json: String) {
    let retain = PulseKitLink.eventName(of: json).map(Self.retainedEvents.contains) ?? false
    notifyListeners("event", data: ["json": json], retainUntilConsumed: retain)
  }
}
