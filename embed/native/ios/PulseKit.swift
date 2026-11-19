import Foundation
import Network
internal import React
import UIKit

/// Pulse inside another app (native-bridge.md §8). Hosts and their Capacitor or Cordova plugin
/// talk to this one class through one JSON transport: a request envelope in, exactly one reply
/// envelope out, plus event envelopes through `onEvent`. A new method therefore needs no plugin
/// change unless the facade itself must answer it.
///
/// - Answered here, natively: contract minor 0 (info, configure, prewarm, open, close, isOpen,
///   pendingResults, acknowledge, logFile) and minor 1's account and read methods (setAccount,
///   listDrafts, getDraft, countDrafts, usage, listNamespaces, purge). Anything else is
///   `method.unsupported` until the facade forwards it to Pulse JS.
/// - Accounts (PulseKitAccounts.swift): each signed-in person has a namespace, under
///   `Library/PulseKit/<ns>` and `Library/Caches/PulseKit/<ns>` (PulseKitStorage.swift). Until
///   `setAccount`, data calls and `open` fail with `no_account`. PR1's `<hostId>-local` is never
///   adopted into an account.
/// - Reads come from catalog.json (PulseKitCatalog.swift) without starting Pulse's runtime.
/// - One flow at a time: the camera and the audio session belong to the whole process.
/// - The facade never opens SQLite; it reads only the files Pulse JS writes.
///
/// The Objective-C names below are frozen: plugins and AppDelegates call them by selector.
@objc(PulseKit)
public final class PulseKit: NSObject {
  @objc public static let shared = PulseKit()

  /// The contract minor this facade answers (info().contract.minor).
  static let contractMinor = 1

  /// What this facade answers (info().methods): minor 0, and minor 1's native methods.
  static let methods: [String] =
    PulseContract.nativeMethods + [
      "setAccount", "listDrafts", "getDraft", "countDrafts", "usage", "listNamespaces", "purge",
    ]

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
  private let accounts = PulseKitAccounts()
  /// The namespace whose folders Pulse JS was given (the first open's): its storage roots and
  /// database are fixed for the runtime's life, so setAccount for another one is
  /// `restart_required` (§4). nil before that, and again once a fatal error means a fresh runtime.
  private var runtimeNamespace: String?
  /// A purge waiting for Pulse JS to let go of the library: open, setAccount and purge are busy.
  private var purging: String?
  private let network = PulseKitNetwork()

  private override init() {
    super.init()
    network.onChange = { [weak self] old, new in self?.networkChanged(from: old, to: new) }
    network.start()
  }

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
    switch PulseRouter.route(
      text, supported: PulseKitInfo.support().supported, methods: Self.methods)
    {
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
      respond(.success(callId, info()))
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
      // Signed out there is no inbox to delete from: like an unknown id, a no-op.
      guard accounts.namespace != nil else { return respond(.success(callId)) }
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
    case "setAccount":
      setAccount(req, respond: respond)
    case "listDrafts":
      switch PulseCatalog.Filter.from(foundation(req.args)) {
      case .failure(let problem):
        respond(.failure("invalid_options", problem.message, callId: callId))
      case .success(let filter):
        withCatalog(callId, respond) { catalog, net in
          .array(PulseCatalog.listDrafts(catalog, filter, net).map { JSONValue(any: $0) })
        }
      }
    case "getDraft":
      guard let id = req.args["id"]?.string, !id.isEmpty else {
        return respond(.failure("invalid_options", "getDraft needs an id.", callId: callId))
      }
      withCatalog(callId, respond) { catalog, net in
        PulseCatalog.getDraft(catalog, id: id, net).map { JSONValue(any: $0) } ?? .null
      }
    case "countDrafts":
      switch PulseCatalog.CountOptions.from(foundation(req.args)) {
      case .failure(let problem):
        respond(.failure("invalid_options", problem.message, callId: callId))
      case .success(let options):
        withCatalog(callId, respond) { catalog, net in
          var out: [String: JSONValue] = [:]
          for group in PulseCatalog.countDrafts(catalog, options, net) {
            out[group.key] = .int(Int64(group.count))
          }
          return .object(out)
        }
      }
    case "usage":
      withCatalog(callId, respond) { catalog, net in
        let c = PulseCatalog.counts(catalog, net)
        let ns = self.accounts.namespace ?? ""
        return .object([
          "namespace": .string(ns),
          "bytes": .int(PulseKitStorage.bytes(of: ns)),
          "drafts": .int(Int64(c.drafts)),
          "unsent": .int(Int64(c.unsent)),
          "uploading": .int(Int64(c.uploading)),
          "failed": .int(Int64(c.failed)),
          "receipts": .int(Int64(c.receipts)),
        ])
      }
    case "listNamespaces":
      respond(.success(callId, .array(accounts.list(net: netView))))
    case "purge":
      purge(req, respond: respond)
    default:
      respond(.failure("method.unsupported", "This PulseKit doesn't answer \(req.method).", callId: callId))
    }
  }

  /// `info()`: the build's stamps (PulseKitInfo.swift) with what this facade answers. The stamped
  /// contract minor comes from the JS client's CONTRACT; the facade reports at least its own.
  private func info() -> JSONValue {
    guard case .object(var o) = PulseKitInfo.json(namespace: accounts.namespace) else {
      return PulseKitInfo.json(namespace: accounts.namespace)
    }
    var contract = o["contract"]?.object ?? [:]
    contract["minor"] = .int(max(contract["minor"]?.integer ?? 0, Int64(Self.contractMinor)))
    o["contract"] = .object(contract)
    o["methods"] = .array(Self.methods.map { .string($0) })
    return .object(o)
  }

  /// The hostId namespaces start with: configure's, or the sanitised bundle id.
  private var hostId: String { config["hostId"]?.string ?? PulseKitInfo.defaultHostId() }

  /// The active account's roots, or `no_account`.
  private func withRoots(
    _ callId: String, _ respond: (PulseReply) -> Void, _ body: (PulseKitRoots) -> JSONValue
  ) {
    do {
      guard let roots = try accounts.activeRoots() else {
        return respond(noAccount(callId))
      }
      respond(.success(callId, body(roots)))
    } catch {
      respond(.failure("unknown", "Pulse's folders aren't available: \(error)", callId: callId))
    }
  }

  /// The active account's catalog (an empty one when there is none yet, or it can't be read) and
  /// the network as the host should see it. A `readOnly` catalog (a newer schema) is read like any
  /// other: such a library still lists, sends and deletes.
  private func withCatalog(
    _ callId: String, _ respond: (PulseReply) -> Void,
    _ body: (PulseCatalog.Catalog, PulseNetworkView) -> JSONValue
  ) {
    let net = netView
    withRoots(callId, respond) { roots in
      // FileRef paths are rebuilt from `rel` under today's container: iOS can move the container
      // on an update or a restore, and catalog.json keeps the old paths until Pulse JS boots.
      let catalog = PulseCatalog.read(in: roots.documents) ?? .empty
      return body(catalog.rebased(documents: roots.documents.path), net)
    }
  }

  private func noAccount(_ callId: String, requestId: String? = nil) -> PulseReply {
    .failure("no_account", "No account is set (setAccount).", callId: callId, requestId: requestId)
  }

  /// JSON args as Foundation values, which the Foundation-only catalog reader takes.
  private func foundation(_ args: [String: JSONValue]) -> [String: Any] {
    args.mapValues(\.foundation)
  }

  // MARK: - Accounts (§4)

  /// The namespace Pulse JS is fixed to, unless a fatal error means the next open starts a fresh
  /// runtime (which takes new roots).
  private var boundNamespace: String? { runtimeBroken ? nil : runtimeNamespace }

  private func setAccount(_ req: PulseRequest, respond: (PulseReply) -> Void) {
    let callId = req.callId
    switch accounts.set(
      req.args, hostId: hostId, flowOpen: flow != nil || purging != nil, bound: boundNamespace,
      callId: callId)
    {
    case .failure(let error):
      log("setAccount \(callId): \(error.code)")
      respond(.failure(error))
    case .success(.cleared):
      log("setAccount \(callId): signed out")
      respond(.success(callId, .object(["namespace": .null])))
    case .success(.unchanged(let ns)):
      respond(.success(callId, .object(["namespace": .string(ns)])))
    case .success(.switched(let ns)):
      log("setAccount \(callId): now \(ns)")
      removeEmptyLocalNamespaces()
      respond(.success(callId, .object(["namespace": .string(ns)])))
    case .success(.restartRequired(let ns)):
      // §4: reads now answer for the new account; open waits for a restart.
      log("setAccount \(callId): now \(ns) for reads; restart_required for Pulse")
      removeEmptyLocalNamespaces()
      respond(
        .failure(
          PulseErrorInfo(
            code: "restart_required",
            message:
              "Pulse already opened another account's library in this process; reads answer for the new account, and Pulse opens for it after the app restarts.",
            callId: callId, details: .object(["namespace": .string(ns)]))))
    }
  }

  private func removeEmptyLocalNamespaces() {
    for removed in PulseKitAccounts.removeEmptyLocalNamespaces(except: runtimeNamespace) {
      log("removed the empty PR1 namespace \(removed)")
    }
  }

  /// `purge({namespace?})`: delete a namespace's drafts, receipts, jobs and files (default: the
  /// active one). If Pulse JS has that library open, it lets go first (`releaseLibrary`); the
  /// folders go only after it says so. The shared models go when no namespace is left. The account
  /// stays signed in: the next call recreates empty folders.
  private func purge(_ req: PulseRequest, respond: @escaping (PulseReply) -> Void) {
    let callId = req.callId
    if flow != nil || purging != nil {
      return respond(.failure("busy", "Pulse is open; purge after it closes.", callId: callId))
    }
    let ns: String
    switch req.args["namespace"] {
    case nil, .null?:
      guard let active = accounts.namespace else { return respond(noAccount(callId)) }
      ns = active
    case .string(let s)?:
      guard PulseKitStorage.isNamespaceName(s) else {
        return respond(.failure("invalid_options", "\(s) isn't a namespace.", callId: callId))
      }
      ns = s
    default:
      return respond(.failure("invalid_options", "namespace must be a string.", callId: callId))
    }
    let wasActive = ns == accounts.namespace
    // The rows that go, for the active namespace's draftsChanged.
    var ids: [JSONValue] = []
    if wasActive, let lib = try? PulseKitStorage.libraryRoot(),
      let catalog = PulseCatalog.read(in: lib.appendingPathComponent(ns, isDirectory: true))
    {
      ids = (catalog.drafts + catalog.receipts).compactMap { ($0["id"] as? String).map { .string($0) } }
    }
    let remove = { [weak self] in
      guard let self else { return }
      do {
        try PulseKitStorage.remove(namespace: ns)
        self.log("purge \(callId): removed \(ns)")
        respond(.success(callId))
        if wasActive {
          self.emit("draftsChanged", .object(["namespace": .string(ns), "ids": .array(ids)]))
        }
      } catch {
        respond(.failure("unknown", "Pulse couldn't delete \(ns): \(error)", callId: callId))
      }
    }
    guard ns == boundNamespace else { return remove() }

    // Pulse JS has this library open: it closes the database and stops its job loop first.
    purging = ns
    var answered = false
    let commandId = sendCommand("releaseLibrary", args: .object(["namespace": .string(ns)])) {
      [weak self] reply in
      guard let self, !answered else { return }
      answered = true
      self.purging = nil
      if reply["ok"]?.bool == true {
        remove()
      } else {
        self.log("purge \(callId): releaseLibrary failed: \(reply["error"]?.serialized ?? "")")
        respond(
          .failure(
            "unknown", "Pulse couldn't close the library; nothing was deleted.", callId: callId))
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
      guard let self, !answered else { return }
      answered = true
      self.commands.removeValue(forKey: commandId)
      self.purging = nil
      self.log("purge \(callId): Pulse didn't let go of \(ns) in 15 s")
      respond(
        .failure(
          "timeout", "Pulse didn't close the library in time; nothing was deleted.", callId: callId))
    }
  }

  // MARK: - Reachability (Q6: PulseKit is the only source)

  /// The network as the catalog reader sees it, with the host's Wi-Fi-only choice.
  private var netView: PulseNetworkView {
    let s = network.state
    return PulseNetworkView(
      online: s.online, wifi: s.wifi,
      wifiOnlyUploads: config["policy"]?["wifiOnlyUploads"]?.bool ?? false)
  }

  /// Every change goes to Pulse JS as `pulse.cmd network` (src/core/network.ts), so Swift and JS
  /// derive `waiting_network` from the same values. When a queued draft's shown state flips, the
  /// host hears `draftsChanged` for those drafts.
  private func networkChanged(from old: PulseKitNetwork.State, to new: PulseKitNetwork.State) {
    if runtimeNamespace != nil, listening {
      sendCommand("network", args: new.json, expectReply: false)
    }
    let wifiOnly = netView.wifiOnlyUploads
    let before = PulseNetworkView(online: old.online, wifi: old.wifi, wifiOnlyUploads: wifiOnly)
    guard PulseCatalog.shownState("queued", before) != PulseCatalog.shownState("queued", netView),
      let ns = accounts.namespace, let lib = try? PulseKitStorage.libraryRoot(),
      let catalog = PulseCatalog.read(in: lib.appendingPathComponent(ns, isDirectory: true))
    else { return }
    let ids = catalog.drafts.filter { $0["state"] as? String == "queued" }
      .compactMap { $0["id"] as? String }
    guard !ids.isEmpty else { return }
    emit("draftsChanged", .object(["namespace": .string(ns), "ids": .array(ids.map { .string($0) })]))
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
    if flow == nil {
      // A flow writes into the active account's library: none, or a purge under way, stops it.
      if purging != nil {
        return respond(
          .failure("busy", "Pulse is deleting a library.", callId: callId, requestId: args.requestId))
      }
      guard let ns = accounts.namespace else {
        return respond(noAccount(callId, requestId: args.requestId))
      }
      if let bound = boundNamespace, bound != ns {
        return respond(
          .failure(
            "restart_required", "Pulse has another account's library open; restart the app.",
            callId: callId, requestId: args.requestId))
      }
    }
    // requestId idempotency outlives the flow: while its result sits unacknowledged in the inbox,
    // the same requestId gets that result back. Presenting again would answer the new flow with
    // the old file (and skip the facade's own fallback), and the new flow's result would replace
    // one the host hasn't seen (AD15).
    let stored: JSONValue? =
      flow == nil
      ? args.requestId.flatMap { id in (try? accounts.activeRoots())?.inbox.read(id) }
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
      guard let active = try accounts.activeRoots() else {
        return respond(noAccount(callId, requestId: args.requestId))
      }
      roots = active
      _ = try? accounts.touch()
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
      // Reachability (Q6): PulseKit's NWPathMonitor is Pulse JS's only source; changes follow as
      // `pulse.cmd network`.
      "network": network.state.json,
    ]

    listen()
    installFatalHandler()
    let audio = PulseKitAudioState.save()
    startRuntime()
    runtimeNamespace = roots.namespace
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
      // A fresh JS runtime takes new storage roots: no namespace is bound until the next open.
      runtimeNamespace = nil
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
      } else if let ns = runtimeNamespace,
        let result = (try? PulseKitStorage.roots(ns))?.inbox.read(requestId)
      {
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

  /// `pulse.cmd` to Pulse JS; its `pulse.reply` goes to `done`. With `expectReply: false` (a
  /// notice such as `network`) nothing waits for one. Returns the command's callId.
  @discardableResult
  private func sendCommand(
    _ method: String, args: JSONValue, expectReply: Bool = true,
    done: ((JSONValue) -> Void)? = nil
  ) -> String {
    let callId = "n-" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
      .prefix(12)
    if expectReply {
      flow?.commandIds.append(callId)
      commands[callId] =
        done ?? { [weak self] reply in
          if reply["ok"]?.bool == false {
            self?.log("pulse.cmd \(method) \(callId) failed: \(reply["error"]?.serialized ?? "")")
          }
        }
    }
    let message: [String: Any?] = [
      "type": "pulse.cmd", "callId": callId, "method": method, "args": args.foundation,
    ]
    BrownfieldMessaging.sendMessage(message)
    return callId
  }

  private func emit(_ name: String, _ payload: JSONValue) {
    onEvent?(PulseEvent(name: name, payload: payload).serialized)
  }

  func log(_ line: String) {
    NSLog("[PulseKit] %@", line)
  }
}

/// The device's network, from NWPathMonitor (Q6: no expo-network; this is the only source).
/// `online`: a usable path. `wifi`: the path runs over Wi-Fi or a wire, not cellular. `expensive`:
/// the system's own flag (cellular, or a hotspot). Changes arrive on the main queue.
final class PulseKitNetwork {
  struct State: Equatable {
    /// Until the monitor's first answer (it comes at once after `start`), assume a usable network:
    /// queued drafts then show as queued rather than waiting.
    var online = true
    var wifi = true
    var expensive = false

    var json: JSONValue {
      .object(["online": .bool(online), "wifi": .bool(wifi), "expensive": .bool(expensive)])
    }
  }

  private(set) var state = State()
  /// Called with the old and the new state, on the main queue, only when something changed.
  var onChange: ((State, State) -> Void)?
  private let monitor = NWPathMonitor()

  func start() {
    monitor.pathUpdateHandler = { [weak self] path in
      let next = State(
        online: path.status == .satisfied,
        wifi: path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet),
        expensive: path.isExpensive)
      DispatchQueue.main.async {
        guard let self, next != self.state else { return }
        let old = self.state
        self.state = next
        self.onChange?(old, next)
      }
    }
    monitor.start(queue: DispatchQueue(label: "com.mieweb.pulsekit.network"))
  }
}
