import Foundation
internal import React
import UIKit

/// Pulse inside another app (native-bridge.md §8). Hosts and their Capacitor or Cordova plugin
/// talk to this one class through one JSON transport: a request envelope in, exactly one reply
/// envelope out, plus event envelopes through `onEvent`. A new method therefore needs no plugin
/// change unless the facade itself must answer it.
///
/// - Contract minor 0 (PR1) is answered here, natively: info, configure, prewarm, open, close,
///   isOpen, pendingResults, acknowledge, logFile. Anything else is `method.unsupported`.
/// - Storage: PR1 has no accounts, so everything lives in the namespace `<hostId>-local`, under
///   `Library/PulseKit/<ns>` and `Library/Caches/PulseKit/<ns>` (PulseKitInbox.swift).
/// - One flow at a time: the camera and the audio session belong to the whole process.
/// - The facade never opens SQLite; it reads only the files Pulse JS writes.
///
/// The Objective-C names below are frozen: plugins and AppDelegates call them by selector.
@objc(PulseKit)
public final class PulseKit: NSObject {
  @objc public static let shared = PulseKit()

  /// Event envelopes (§2.3), on the main queue. Set by the plugin; one subscriber.
  @objc public var onEvent: ((String) -> Void)?

  /// Background URLSession completion handlers by session identifier (PulseKitBackground.swift).
  var backgroundCompletions: [String: () -> Void] = [:]

  private var config: [String: JSONValue] = [:]
  private var flow: Flow?
  private var commands: [String: (JSONValue) -> Void] = [:]
  private var listening = false
  private var fatalHandlerInstalled = false
  /// Set by a fatal JS error: the next open starts a fresh React Native instance.
  private var runtimeBroken = false

  private override init() { super.init() }

  /// The open flow: one request, presented once, ended by exactly one result.
  private final class Flow {
    let requestId: String
    let callId: String
    let request: [String: JSONValue]
    let roots: PulseKitRoots
    let audio: PulseKitAudioState
    let container: PulseKitContainerViewController
    /// Every `open` waiting for this request: the first, and any with the same requestId.
    var waiters: [(callId: String, reply: (PulseReply) -> Void)]
    var forceClose: DispatchWorkItem?
    /// The `pulse.cmd` callIds sent while this flow was open; `finish` drops the ones still
    /// waiting, since a runtime that died or wasn't listening yet will never reply.
    var commandIds: [String] = []

    init(
      requestId: String, callId: String, request: [String: JSONValue], roots: PulseKitRoots,
      audio: PulseKitAudioState, container: PulseKitContainerViewController,
      reply: @escaping (PulseReply) -> Void
    ) {
      self.requestId = requestId
      self.callId = callId
      self.request = request
      self.roots = roots
      self.audio = audio
      self.container = container
      waiters = [(callId, reply)]
    }
  }

  // MARK: - Transport

  /// The whole transport: one request envelope in, one reply envelope out, on the main queue.
  /// `presenter` is needed only for `open`; other methods ignore it. `open` replies when the
  /// flow ends.
  @objc(callWithJSON:presenter:reply:)
  public func call(
    _ requestJSON: String, presenter: UIViewController?, reply: @escaping (String) -> Void
  ) {
    let respond: (PulseReply) -> Void = { reply($0.serialized) }
    if Thread.isMainThread {
      handle(requestJSON, presenter: presenter, respond: respond)
    } else {
      DispatchQueue.main.async {
        self.handle(requestJSON, presenter: presenter, respond: respond)
      }
    }
  }

  private func handle(
    _ text: String, presenter: UIViewController?, respond: @escaping (PulseReply) -> Void
  ) {
    switch PulseRouter.route(text, supported: PulseKitInfo.support().supported) {
    case .reply(let reply):
      log("call \(reply.callId): \(reply.error?.code ?? "ok")")
      respond(reply)
    case .native(let request):
      answer(request, presenter: presenter, respond: respond)
    }
  }

  private func answer(
    _ req: PulseRequest, presenter: UIViewController?, respond: @escaping (PulseReply) -> Void
  ) {
    let callId = req.callId
    switch req.method {
    case "info":
      respond(.success(callId, PulseKitInfo.json(namespace: namespace)))
    case "configure":
      if let error = PulseArgs.configure(req.args, callId: callId) {
        return respond(.failure(error))
      }
      config = req.args
      respond(.success(callId))
    case "prewarm":
      startRuntime()
      respond(.success(callId))
    case "open":
      open(req, presenter: presenter, respond: respond)
    case "close":
      close(req, respond: respond)
    case "isOpen":
      respond(.success(callId, .bool(flow != nil)))
    case "pendingResults":
      withRoots(callId, respond) { .array($0.inbox.pending()) }
    case "acknowledge":
      guard let requestId = req.args["requestId"]?.string, pulseIsPlainName(requestId) else {
        return respond(.failure("invalid_options", "acknowledge needs a requestId.", callId: callId))
      }
      withRoots(callId, respond) { roots in
        roots.inbox.acknowledge(requestId)
        return .null
      }
    case "logFile":
      if config["policy"]?["logs"]?.string == "off" {
        return respond(.failure("not_found", "Logs are off (policy.logs).", callId: callId))
      }
      withRoots(callId, respond) { roots in
        let url = roots.logFile
        try? FileManager.default.createDirectory(
          at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber
        return .object([
          "rel": .string("logs/pulse.log"), "path": .string(url.path), "webUrl": .string(""),
          "bytes": .int(size?.int64Value ?? 0),
        ])
      }
    default:
      respond(.failure("method.unsupported", "This PulseKit doesn't answer \(req.method).", callId: callId))
    }
  }

  /// PR1's namespace: `<hostId>-local`, hostId from configure or the sanitised bundle id.
  private var namespace: String {
    PulseNamespace.local(hostId: config["hostId"]?.string ?? PulseKitInfo.defaultHostId())
  }

  private func withRoots(
    _ callId: String, _ respond: (PulseReply) -> Void, _ body: (PulseKitRoots) -> JSONValue
  ) {
    do {
      respond(.success(callId, body(try PulseKitRoots(namespace: namespace))))
    } catch {
      respond(.failure("unknown", "Pulse's folders aren't available: \(error)", callId: callId))
    }
  }

  // MARK: - Flows

  private func open(
    _ req: PulseRequest, presenter: UIViewController?, respond: @escaping (PulseReply) -> Void
  ) {
    let callId = req.callId
    let args: PulseOpenArgs
    switch PulseArgs.open(req.args, callId: callId) {
    case .failure(let error): return respond(.failure(error))
    case .success(let a): args = a
    }
    let state: PulsePresenterState
    if let presenter {
      // Out of a window, `present` fails with only a UIKit warning: the flow would stay set, the
      // reply would never come and every later open would be busy.
      state =
        presenter.presentedViewController != nil
        ? .presenting : presenter.viewIfLoaded?.window == nil ? .detached : .idle
    } else {
      state = .none
    }
    // requestId idempotency outlives the flow: while its result sits unacknowledged in the inbox,
    // the same requestId gets that result back. Presenting again would answer the new flow with
    // the old file (and skip the facade's own fallback), and the new flow's result would replace
    // one the host hasn't seen (AD15).
    let stored: JSONValue? =
      flow == nil
      ? args.requestId.flatMap { id in (try? PulseKitRoots(namespace: namespace))?.inbox.read(id) }
      : nil
    let decision = PulseOpenGate.decide(
      openRequestId: flow?.requestId, requestId: args.requestId, presenter: state,
      pending: stored != nil)
    if decision == .delivered, let stored {
      log("open \(callId): \(args.requestId ?? "?") already ended; answering from the inbox")
      return respond(.success(callId, stored))
    }
    if decision == .join, let flow {
      log("open \(callId): joins \(flow.requestId)")
      flow.waiters.append((callId, respond))
      return
    }
    if decision == .busy {
      return respond(
        .failure(
          "busy", "Pulse is already open, or the app is showing another screen.", callId: callId,
          requestId: args.requestId))
    }
    guard decision == .start, let presenter else {
      return respond(
        .failure("host_misconfigured", "open needs a view controller to present from.", callId: callId))
    }

    let missing = PulseKitInfo.missingRequiredKeys()
    guard missing.isEmpty else {
      return respond(
        .failure(
          PulseErrorInfo(
            code: "host_misconfigured",
            message: "The app's Info.plist lacks \(missing.joined(separator: ", ")).",
            callId: callId, requestId: args.requestId,
            details: .object(["missing": .array(missing.map { .string($0) })]))))
    }
    let roots: PulseKitRoots
    do {
      roots = try PulseKitRoots(namespace: namespace)
    } catch {
      return respond(.failure("unknown", "Pulse's folders aren't available: \(error)", callId: callId))
    }

    let requestId = args.requestId ?? UUID().uuidString.lowercased()
    var request = args.request
    request["requestId"] = .string(requestId)
    let theme = request["theme"].flatMap { $0 == .null ? nil : $0 } ?? config["theme"]
    // The root component's initial props (§8.1).
    let props: [String: JSONValue] = [
      "requestId": .string(requestId),
      "request": .object(request),
      "documentsDir": .string(roots.documents.path),
      "cachesDir": .string(roots.caches.path),
      "modelsDir": .string(roots.models.path),
      "namespace": .string(roots.namespace),
      "config": .object(effectiveConfig(callId: callId)),
      "headless": .bool(false),
    ]

    listen()
    installFatalHandler()
    let audio = PulseKitAudioState.save()
    startRuntime()
    let initialProps: [AnyHashable: Any] = props.mapValues(\.foundation)
    let content = ReactNativeViewController(moduleName: "main", initialProps: initialProps)
    let container = PulseKitContainerViewController(content: content, theme: theme)
    let flow = Flow(
      requestId: requestId, callId: callId, request: request, roots: roots, audio: audio,
      container: container, reply: respond)
    container.onDismissedByHost = { [weak self, weak flow] in
      guard let self, let flow, self.flow === flow else { return }
      self.log("open \(flow.callId): the app dismissed Pulse")
      self.finish(flow.roots.inbox.read(flow.requestId) ?? self.interrupted(flow, reason: "interrupted"))
    }
    self.flow = flow
    log("open \(callId): \(args.entry) as \(requestId) in \(roots.namespace)")
    PulseKitPresenter.present(container, from: presenter)
  }

  /// The host's options as Pulse JS gets them, with what the host's Info.plist rules out: no
  /// NSPhotoLibraryAddUsageDescription means no Save to Photos (AD30), whatever the policy says.
  private func effectiveConfig(callId: String) -> [String: JSONValue] {
    var out = config
    if !PulseKitInfo.hostHas("NSPhotoLibraryAddUsageDescription") {
      var policy = out["policy"]?.object ?? [:]
      policy["allowSaveToPhotos"] = .bool(false)
      out["policy"] = .object(policy)
      log("open \(callId): host_misconfigured: no NSPhotoLibraryAddUsageDescription, Save to Photos is hidden")
    }
    return out
  }

  /// `close`: ask Pulse JS to end the flow (it writes the result, as for X), and dismiss anyway
  /// after 5 s if it doesn't.
  private func close(_ req: PulseRequest, respond: (PulseReply) -> Void) {
    guard let flow else { return respond(.success(req.callId)) }
    var args = req.args
    if args["reason"] == nil { args["reason"] = .string("host") }
    sendCommand("close", args: .object(args))
    if flow.forceClose == nil {
      let work = DispatchWorkItem { [weak self, weak flow] in
        guard let self, let flow, self.flow === flow else { return }
        self.log("close: Pulse didn't end \(flow.requestId) in 5 s; dismissing it")
        self.finish(flow.roots.inbox.read(flow.requestId) ?? self.interrupted(flow, reason: "host"))
      }
      flow.forceClose = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
    }
    respond(.success(req.callId))
  }

  /// End the open flow with `result`: make sure the inbox has it, dismiss, give the audio session
  /// back, then resolve every waiting `open` and emit `flowResult`.
  private func finish(_ result: JSONValue) {
    guard let flow else { return }
    self.flow = nil
    flow.forceClose?.cancel()
    for id in flow.commandIds where commands.removeValue(forKey: id) != nil {
      log("pulse.cmd \(id): no reply before \(flow.requestId) ended; dropped")
    }
    flow.roots.inbox.writeIfAbsent(result, requestId: flow.requestId)
    log("open \(flow.callId): ended \(result["status"]?.string ?? "?") for \(flow.requestId)")
    PulseKitPresenter.dismiss(flow.container) { [weak self] in
      // Retries stop once another flow has opened: the session is that flow's then.
      flow.audio.restore(while: { [weak self] in self?.flow == nil })
      for waiter in flow.waiters { waiter.reply(.success(waiter.callId, result)) }
      self?.emit("flowResult", result)
    }
  }

  /// The facade's own result for a flow Pulse JS didn't end in time (a forced close, or the host
  /// dismissing Pulse itself). With a take on screen (`pulse.ui` hasTake) and a known draft it is
  /// `closed`, as `close()` promises; otherwise `canceled`, because `closed` needs a draftId the
  /// facade doesn't know for a new recording. Either way it is only a fallback: if Pulse JS writes
  /// its own result for this requestId later, that file replaces this one and a second
  /// `flowResult` follows; the host acts on the later one (vectors/README.md).
  private func interrupted(_ flow: Flow, reason: String) -> JSONValue {
    if flow.container.hasTake, let draftId = Self.draftId(flow.request) {
      return ended(
        flow, status: "closed",
        ["reason": .string(reason), "draftId": .string(draftId), "stage": .string("recorded")])
    }
    return ended(flow, status: "canceled", ["reason": .string(reason)])
  }

  private static func draftId(_ request: [String: JSONValue]) -> String? {
    request["draftId"]?.string ?? request["draft"]?["continue"]?.string
  }

  /// A result the facade writes itself, when the flow ended without one from Pulse JS.
  private func ended(_ flow: Flow, status: String, _ extra: [String: JSONValue]) -> JSONValue {
    let request = flow.request
    var o: [String: JSONValue] = [
      "status": .string(status),
      "requestId": .string(flow.requestId),
      "entry": request["entry"] ?? .null,
      "endedOn": .null,
      "stage": .string("none"),
      "context": request["context"] ?? .null,
      "endedAt": .int(Int64(Date().timeIntervalSince1970 * 1000)),
    ]
    if let draftId = Self.draftId(request) { o["draftId"] = .string(draftId) }
    o.merge(extra) { _, new in new }
    return .object(o)
  }

  private func failed(_ flow: Flow, _ message: String) -> JSONValue {
    let error = PulseErrorInfo(
      code: "runtime.error", message: message, callId: flow.callId, requestId: flow.requestId)
    return ended(flow, status: "failed", ["error": error.json])
  }

  // MARK: - Pulse JS

  /// Boot React Native once; after a fatal error, a fresh instance for the next root.
  private func startRuntime() {
    let host = ReactNativeHostManager.shared
    host.initialize()
    if runtimeBroken {
      log("starting a fresh React Native instance after a fatal error")
      host.cleanupPreviousInstance()
      host.initializeInstance()
      runtimeBroken = false
    }
  }

  /// JS error isolation (B3): a fatal error inside Pulse ends the open flow as
  /// `failed{runtime.error}` instead of crashing the host.
  ///
  /// Release builds only: React Native's RCTExceptionsManager calls RCTFatal for a fatal JS
  /// exception only when `!RCT_DEV`. A Debug PulseKit shows a RedBox instead, and this handler
  /// never runs. Installed once, for the process's
  /// lifetime, because the runtime outlives the flow: a fatal after the flow ended goes to the
  /// handler that was there before, or is logged.
  private func installFatalHandler() {
    guard !fatalHandlerInstalled else { return }
    fatalHandlerInstalled = true
    let previous = RCTGetFatalHandler()
    RCTSetFatalHandler { [weak self] (error: Error?) in
      let message = (error as NSError?)?.localizedDescription ?? "Pulse stopped on an error."
      DispatchQueue.main.async {
        guard let self else { return }
        self.runtimeBroken = true
        if let flow = self.flow {
          self.log("open \(flow.callId): fatal JS error: \(message)")
          self.finish(self.failed(flow, message))
        } else if let previous {
          previous(error)
        } else {
          self.log("fatal JS error with no flow open: \(message)")
        }
      }
    }
  }

  /// Messages from Pulse JS (§8.1), handled on the main queue.
  private func listen() {
    guard !listening else { return }
    listening = true
    BrownfieldMessaging.addListener { [weak self] message in
      let value = JSONValue(any: message)
      DispatchQueue.main.async { self?.onMessage(value) }
    }
  }

  private func onMessage(_ message: JSONValue) {
    switch message["type"]?.string {
    case "pulse.result":
      guard let requestId = message["requestId"]?.string else { return }
      if let flow, flow.requestId == requestId {
        finish(
          flow.roots.inbox.read(requestId)
            ?? ended(
              flow, status: "failed",
              [
                "error": PulseErrorInfo(
                  code: "unknown", message: "Pulse finished but its result is missing.",
                  callId: flow.callId, requestId: requestId
                ).json
              ]))
      } else if let result = (try? PulseKitRoots(namespace: namespace))?.inbox.read(requestId) {
        // A flow the facade already ended (a forced close): the inbox has Pulse's own result now.
        emit("flowResult", result)
      }
    case "pulse.error":
      guard let flow, flow.requestId == message["requestId"]?.string else { return }
      finish(failed(flow, message["message"]?.string ?? "Pulse couldn't open."))
    case "pulse.reply":
      guard let callId = message["callId"]?.string,
        let done = commands.removeValue(forKey: callId)
      else { return }
      done(message)
    case "pulse.event":
      guard let name = message["name"]?.string else { return }
      emit(name, message["payload"] ?? .null)
    case "pulse.ui":
      // Not in native-bridge.md §8.1 yet: a PR1 contract addition (vectors/README.md).
      flow?.container.apply(ui: message)
    default:
      break
    }
  }

  /// `pulse.cmd` to Pulse JS; its `pulse.reply` goes to `done`.
  private func sendCommand(
    _ method: String, args: JSONValue, done: ((JSONValue) -> Void)? = nil
  ) {
    let callId = "n-" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
      .prefix(12)
    flow?.commandIds.append(callId)
    commands[callId] =
      done ?? { [weak self] reply in
        if reply["ok"]?.bool == false {
          self?.log("pulse.cmd \(method) \(callId) failed: \(reply["error"]?.serialized ?? "")")
        }
      }
    let message: [String: Any?] = [
      "type": "pulse.cmd", "callId": callId, "method": method, "args": args.foundation,
    ]
    BrownfieldMessaging.sendMessage(message)
  }

  private func emit(_ name: String, _ payload: JSONValue) {
    onEvent?(PulseEvent(name: name, payload: payload).serialized)
  }

  func log(_ line: String) {
    NSLog("[PulseKit] %@", line)
  }
}
