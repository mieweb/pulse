import Foundation

/// Cordova transport for PulseKit (native-bridge.md §7.2). It holds no Pulse logic:
///
/// - `call`: one request envelope (a JSON string) in; the success callback gets the reply
///   envelope. A Pulse error is a reply with `ok: false`; the error callback is only for transport
///   failures (no JSON string, or PulseKit isn't linked). `open` replies when the flow ends.
/// - `subscribe`: event envelopes, one result each with keepCallback. One subscriber at a time; a
///   new `subscribe` replaces the old one. `flowResult` and `hostRequest` wait while nobody is
///   subscribed (the page is loading or reloading); the other events are dropped then, because the
///   client re-reads the catalog after it subscribes.
/// - `unsubscribe`: releases the subscriber, so those two events wait again.
///
/// Cordova runs plugin methods, `onReset` and PulseKit's events on the main thread, so the state
/// below needs no lock.
@objc(PulseCordova)
class PulseCordova: CDVPlugin {
  private static let retainedEvents: Set<String> = ["flowResult", "hostRequest"]
  /// Enough for any real backlog (one flow result, a few host requests); the oldest go first.
  private static let bufferLimit = 64

  private var subscriber: String?
  private var waiting: [String] = []

  override func pluginInitialize() {
    super.pluginInitialize()
    let linked = PulseKitLink.setOnEvent { [weak self] json in self?.deliver(json) }
    if !linked { NSLog("[Pulse] %@ Every call will fail.", PulseKitLink.missing) }
  }

  /// The page navigated or reloaded: its callbacks are gone, so retained events wait again.
  override func onReset() {
    subscriber = nil
    super.onReset()
  }

  @objc(call:)
  func call(_ command: CDVInvokedUrlCommand) {
    let callbackId: String = command.callbackId
    guard let json = command.arguments.first as? String else {
      return fail(callbackId, "Pulse.call takes one JSON string.")
    }
    let sent = PulseKitLink.call(json, presenter: viewController) { [weak self] reply in
      self?.commandDelegate.send(CDVPluginResult(status: .ok, messageAs: reply), callbackId: callbackId)
    }
    if !sent { fail(callbackId, PulseKitLink.missing) }
  }

  @objc(subscribe:)
  func subscribe(_ command: CDVInvokedUrlCommand) {
    let callbackId: String = command.callbackId
    if let old = subscriber, old != callbackId { release(old) }
    subscriber = callbackId
    let backlog = waiting
    waiting.removeAll()
    if backlog.isEmpty {
      // Nothing to send yet: register the callback without calling it.
      let result = CDVPluginResult(status: .noResult)
      result.keepCallback = NSNumber(value: true)
      commandDelegate.send(result, callbackId: callbackId)
    }
    backlog.forEach { emit($0, to: callbackId) }
  }

  @objc(unsubscribe:)
  func unsubscribe(_ command: CDVInvokedUrlCommand) {
    if let old = subscriber { release(old) }
    subscriber = nil
    commandDelegate.send(CDVPluginResult(status: .ok), callbackId: command.callbackId)
  }

  private func deliver(_ json: String) {
    if let subscriber { return emit(json, to: subscriber) }
    guard let name = PulseKitLink.eventName(of: json), Self.retainedEvents.contains(name) else {
      return
    }
    waiting.append(json)
    if waiting.count > Self.bufferLimit { waiting.removeFirst(waiting.count - Self.bufferLimit) }
  }

  private func emit(_ json: String, to callbackId: String) {
    let result = CDVPluginResult(status: .ok, messageAs: json)
    result.keepCallback = NSNumber(value: true)
    commandDelegate.send(result, callbackId: callbackId)
  }

  /// Drops a callback from cordova's registry without calling it.
  private func release(_ callbackId: String) {
    let result = CDVPluginResult(status: .noResult)
    result.keepCallback = NSNumber(value: false)
    commandDelegate.send(result, callbackId: callbackId)
  }

  private func fail(_ callbackId: String, _ message: String) {
    commandDelegate.send(CDVPluginResult(status: .error, messageAs: message), callbackId: callbackId)
  }
}
