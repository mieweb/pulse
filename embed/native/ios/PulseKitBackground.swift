import Foundation
import UIKit

/// Background uploads (E5, H5, PLAN §6.3, O16). Pulse JS's TUS client hands each PATCH to PulseKit,
/// which runs it as ONE background `uploadTask(fromFile:)` of all the bytes left, in the
/// namespace's own background session `com.mieweb.pulsekit.upload.<namespace>`. iOS finishes that
/// task with no JS running: after Pulse closes, while the host is suspended or after the system
/// terminated it, and with the phone locked (namespace files are
/// `completeUntilFirstUserAuthentication`, PulseKitStorage.swift). Spike S5 showed why it is one
/// PATCH and not one per chunk: iOS held a task created while the app was in the background for
/// more than 14 minutes with the phone locked, so nothing may need scheduling once the app has
/// left the foreground. A later run resumes from the server's offset (TUS HEAD, in JS).
///
/// - The sessions are (re)created at process launch, with no UI and no React Native runtime: by
///   the host's launch hook (`prepareBackgroundUploads`), by the forwarded
///   `handleEventsForBackgroundURLSession`, or by the first message from Pulse JS. Their tasks are
///   then reattached: a PATCH for an upload that still has a running task attaches to it instead
///   of starting another.
/// - Tasks are matched by `taskDescription` (`pulse1|<offset>|<staged file or ->|<upload URL>`).
///   `sweep` cancels only the tasks of uploads that belong to no live job.
/// - The host's completion handler is kept until the session has delivered its events
///   (`urlSessionDidFinishEvents`), then called on the main queue.
/// - `beginBackgroundTask` covers the scheduling of each PATCH (staging a resumed slice, creating
///   the task), so a host leaving the foreground mid-step still gets its task queued.
///
/// Messages, over BrownfieldMessaging (the JS side is native-chunk-upload.ts):
///
///     JS → PulseKit  {type:"pulse.upload", op:"hello"|"patch"|"cancel"|"sweep", id, ...}
///     PulseKit → JS  {type:"pulse.upload.progress", id, sent}
///                    {type:"pulse.upload.end", id, ok, status?, headers?, cancelled?, error?}
extension PulseKit {
  /// Background sessions Pulse owns are named `com.mieweb.pulsekit.upload.<namespace>` (§4).
  static let backgroundSessionPrefix = PulseKitUploads.prefix

  /// Returns true when the session is Pulse's: PulseKit then calls `completionHandler` once the
  /// session has delivered its events. Returns false, without calling it, for any other session;
  /// the host handles those itself.
  ///
  /// Frozen Objective-C name: `handleEventsForBackgroundURLSession:completionHandler:`, with the
  /// C signature `BOOL (id self, SEL _cmd, NSString *identifier, void (^completionHandler)(void))`.
  @objc(handleEventsForBackgroundURLSession:completionHandler:)
  public func handleEventsForBackgroundURLSession(
    _ identifier: String, completionHandler: @escaping () -> Void
  ) -> Bool {
    guard identifier.hasPrefix(Self.backgroundSessionPrefix) else { return false }
    PulseKitUploads.shared.handleEvents(identifier, completionHandler: completionHandler)
    return true
  }

  /// The host's launch hook: call it from `application(_:didFinishLaunchingWithOptions:)`, by
  /// selector on the class like `shared`. It recreates every namespace's upload session, so tasks
  /// iOS kept running across a termination have a delegate again even when Pulse never opens in
  /// this process. Cheap, and safe to call more than once.
  @objc(prepareBackgroundUploads)
  public static func prepareBackgroundUploads() {
    PulseKitUploads.shared.start()
  }
}

/// The background upload sessions, one per namespace. All state lives on `queue`, which is also
/// the sessions' delegate queue.
final class PulseKitUploads: NSObject, URLSessionDataDelegate {
  static let shared = PulseKitUploads()
  static let prefix = "com.mieweb.pulsekit.upload."
  /// Where a resumed PATCH's bytes are staged, under the namespace's caches root.
  static let stagingFolder = "upload-staging"

  /// A PATCH Pulse JS waits for: its message id, and the offset it asked to send from.
  private struct Waiter {
    let id: String
    let offset: Int64
  }

  /// What a task's `taskDescription` holds: where its body starts, the staged slice it reads (if
  /// any), and the upload it belongs to.
  private struct TaskInfo {
    let offset: Int64
    let staging: String?
    let url: String

    var text: String { "pulse1|\(offset)|\(staging ?? "-")|\(url)" }

    init(offset: Int64, staging: String?, url: String) {
      self.offset = offset
      self.staging = staging
      self.url = url
    }

    init?(_ text: String?) {
      guard
        let parts = text?.split(separator: "|", maxSplits: 3, omittingEmptySubsequences: false),
        parts.count == 4, parts[0] == "pulse1", let offset = Int64(parts[1])
      else { return nil }
      self.offset = offset
      staging = parts[2] == "-" ? nil : String(parts[2])
      url = String(parts[3])
    }
  }

  private let queue: OperationQueue = {
    let q = OperationQueue()
    q.maxConcurrentOperationCount = 1
    q.name = "com.mieweb.pulsekit.upload"
    return q
  }()
  private var sessions: [String: URLSession] = [:]
  private var completions: [String: () -> Void] = [:]
  /// Waiters by task key (`<session identifier>#<task identifier>`).
  private var waiters: [String: [Waiter]] = [:]
  private var lastProgress: [String: Date] = [:]
  private var listenerId: String?
  private let protection = FileProtectionType.completeUntilFirstUserAuthentication

  private override init() { super.init() }

  // MARK: - Lifecycle

  /// Listen for Pulse JS and reattach every namespace's session. Idempotent.
  func start() {
    queue.addOperation {
      self.listen()
      for ns in PulseKitStorage.namespaceNames() { _ = self.session(Self.prefix + ns) }
    }
  }

  /// The forwarded `handleEventsForBackgroundURLSession`: keep the handler, make the session.
  func handleEvents(_ identifier: String, completionHandler: @escaping () -> Void) {
    queue.addOperation {
      self.listen()
      self.completions[identifier] = completionHandler
      self.log("background events for \(identifier)")
      _ = self.session(identifier)
    }
  }

  private func listen() {
    guard listenerId == nil else { return }
    listenerId = BrownfieldMessaging.addListener { [weak self] message in
      guard let self, message["type"] as? String == "pulse.upload" else { return }
      self.queue.addOperation { self.onMessage(message) }
    }
  }

  /// The session called `identifier`, made on first use (which reattaches its tasks).
  private func session(_ identifier: String) -> URLSession {
    if let existing = sessions[identifier] { return existing }
    let config = URLSessionConfiguration.background(withIdentifier: identifier)
    config.isDiscretionary = false
    config.sessionSendsLaunchEvents = true
    let made = URLSession(configuration: config, delegate: self, delegateQueue: queue)
    sessions[identifier] = made
    log("session \(identifier) ready")
    return made
  }

  // MARK: - Messages from Pulse JS (on `queue`)

  private func onMessage(_ message: [String: Any?]) {
    guard let id = message["id"] as? String, let op = message["op"] as? String else { return }
    switch op {
    case "hello":
      end(id, ["ok": true])
    case "patch":
      patch(id, message)
    case "cancel":
      cancel(id)
    case "sweep":
      let live = (message["live"] as? [Any])?.compactMap { $0 as? String } ?? []
      sweep(id, live: Set(live))
    default:
      fail(id, "Unknown upload operation \(op).")
    }
  }

  private func patch(_ id: String, _ m: [String: Any?]) {
    guard let url = m["url"] as? String, let target = URL(string: url),
      let offset = (m["offset"] as? NSNumber)?.int64Value,
      let length = (m["length"] as? NSNumber)?.int64Value, length > 0,
      let path = m["path"] as? String
    else { return fail(id, "A PATCH needs url, offset, length and path.") }
    let headers = (m["headers"] as? [String: Any])?.compactMapValues { $0 as? String } ?? [:]
    guard let ns = namespace(of: path) else {
      return fail(id, "\(path) isn't in a PulseKit namespace.")
    }
    let s = session(Self.prefix + ns)
    s.getAllTasks { tasks in
      self.queue.addOperation {
        // §6.3 step 1: a task iOS kept running for this upload is reattached, not duplicated.
        if let running = tasks.first(where: {
          $0.state == .running && TaskInfo($0.taskDescription)?.url == url
        }) {
          self.log("PATCH \(id): attached to task \(running.taskIdentifier)")
          self.waiters[self.key(s, running), default: []].append(Waiter(id: id, offset: offset))
          return
        }
        self.schedule(
          id, session: s, target: target, url: url, offset: offset, length: length,
          source: URL(fileURLWithPath: path), namespace: ns, headers: headers)
      }
    }
  }

  private func schedule(
    _ id: String, session s: URLSession, target: URL, url: String, offset: Int64, length: Int64,
    source: URL, namespace ns: String, headers: [String: String]
  ) {
    let background = beginBackground("pulsekit.upload.schedule")
    defer { endBackground(background) }
    let size = (try? FileManager.default.attributesOfItem(atPath: source.path))?[.size] as? NSNumber
    var body = source
    var staging: String?
    if offset > 0 || length < (size?.int64Value ?? 0) {
      // The bytes left, as a file of their own: a background task uploads whole files only.
      do {
        let dir = try stagingDir(ns)
        try FileManager.default.createDirectory(
          at: dir, withIntermediateDirectories: true, attributes: [.protectionKey: protection])
        let name = UUID().uuidString.lowercased() + ".bin"
        body = dir.appendingPathComponent(name)
        try copy(source, from: offset, length: length, to: body)
        staging = name
      } catch {
        return fail(id, "Couldn't stage the bytes to send: \(error.localizedDescription)")
      }
    }
    var request = URLRequest(url: target)
    request.httpMethod = "PATCH"
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    let task = s.uploadTask(with: request, fromFile: body)
    task.taskDescription = TaskInfo(offset: offset, staging: staging, url: url).text
    waiters[key(s, task), default: []].append(Waiter(id: id, offset: offset))
    task.resume()
    log("PATCH \(id): task \(task.taskIdentifier), \(length) bytes from \(offset)")
  }

  /// Pulse JS stopped waiting (Cancel sending, or the account went inactive): the task goes too
  /// when nobody else waits for it.
  private func cancel(_ id: String) {
    for (taskKey, list) in waiters where list.contains(where: { $0.id == id }) {
      let rest = list.filter { $0.id != id }
      waiters[taskKey] = rest.isEmpty ? nil : rest
      guard rest.isEmpty, let hash = taskKey.lastIndex(of: "#"),
        let taskId = Int(taskKey[taskKey.index(after: hash)...]),
        let s = sessions[String(taskKey[..<hash])]
      else { continue }
      s.getAllTasks { tasks in tasks.first { $0.taskIdentifier == taskId }?.cancel() }
    }
    end(id, ["ok": false, "error": ["message": "Cancelled.", "canceled": true]])
  }

  /// Cancel every task, in every session, whose upload isn't in `live` (§6.3 step 1).
  private func sweep(_ id: String, live: Set<String>) {
    for ns in PulseKitStorage.namespaceNames() { _ = session(Self.prefix + ns) }
    let group = DispatchGroup()
    let lock = NSLock()
    var cancelled = 0
    for s in sessions.values {
      group.enter()
      s.getAllTasks { tasks in
        for task in tasks where task.state != .completed {
          if let info = TaskInfo(task.taskDescription), live.contains(info.url) { continue }
          task.cancel()
          lock.lock()
          cancelled += 1
          lock.unlock()
        }
        group.leave()
      }
    }
    group.notify(queue: .main) {
      self.queue.addOperation {
        if cancelled > 0 { self.log("sweep: \(cancelled) task(s) of no live job cancelled") }
        self.end(id, ["ok": true, "cancelled": cancelled])
      }
    }
  }

  // MARK: - URLSession delegate (on `queue`)

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64, totalBytesExpectedToSend: Int64
  ) {
    let taskKey = key(session, task)
    guard let list = waiters[taskKey], !list.isEmpty else { return }
    let now = Date()
    if let last = lastProgress[taskKey], now.timeIntervalSince(last) < 0.25 { return }
    lastProgress[taskKey] = now
    let start = TaskInfo(task.taskDescription)?.offset ?? 0
    for waiter in list {
      let sent = max(0, start + totalBytesSent - waiter.offset)
      send(["type": "pulse.upload.progress", "id": waiter.id, "sent": sent])
    }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?
  ) {
    let taskKey = key(session, task)
    if let staging = TaskInfo(task.taskDescription)?.staging,
      let ns = session.configuration.identifier.flatMap(namespace(ofSession:)),
      let dir = try? stagingDir(ns)
    {
      try? FileManager.default.removeItem(at: dir.appendingPathComponent(staging))
    }
    lastProgress[taskKey] = nil
    let list = waiters.removeValue(forKey: taskKey) ?? []
    if let error = error as NSError? {
      log("task \(task.taskIdentifier) ended: \(error.domain) \(error.code)")
      let canceled = error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled
      for waiter in list {
        end(
          waiter.id,
          ["ok": false, "error": ["message": error.localizedDescription, "canceled": canceled]])
      }
      return
    }
    let http = task.response as? HTTPURLResponse
    var headers: [String: String] = [:]
    for (name, value) in http?.allHeaderFields ?? [:] {
      if let name = name as? String { headers[name] = "\(value)" }
    }
    log("task \(task.taskIdentifier) ended: HTTP \(http?.statusCode ?? 0)")
    for waiter in list {
      end(waiter.id, ["ok": true, "status": http?.statusCode ?? 0, "headers": headers])
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    guard let identifier = session.configuration.identifier,
      let completion = completions.removeValue(forKey: identifier)
    else { return }
    log("background events delivered for \(identifier)")
    DispatchQueue.main.async(execute: completion)
  }

  // MARK: - Helpers

  private func key(_ session: URLSession, _ task: URLSessionTask) -> String {
    "\(session.configuration.identifier ?? "")#\(task.taskIdentifier)"
  }

  private func stagingDir(_ ns: String) throws -> URL {
    try PulseKitRoots(namespace: ns).caches.appendingPathComponent(
      Self.stagingFolder, isDirectory: true)
  }

  /// The namespace a file belongs to: its first folder under `Library/PulseKit`.
  private func namespace(of path: String) -> String? {
    guard let root = try? PulseKitStorage.libraryRoot().standardizedFileURL.path else { return nil }
    let file = URL(fileURLWithPath: path).standardizedFileURL.path
    guard file.hasPrefix(root + "/") else { return nil }
    guard let first = file.dropFirst(root.count + 1).split(separator: "/").first else { return nil }
    let ns = String(first)
    return PulseKitStorage.isNamespaceName(ns) ? ns : nil
  }

  private func namespace(ofSession identifier: String) -> String? {
    identifier.hasPrefix(Self.prefix) ? String(identifier.dropFirst(Self.prefix.count)) : nil
  }

  /// `length` bytes of `source` from `offset`, into a new file in the namespace's protection class.
  private func copy(_ source: URL, from offset: Int64, length: Int64, to dest: URL) throws {
    let reader = try FileHandle(forReadingFrom: source)
    defer { try? reader.close() }
    try reader.seek(toOffset: UInt64(offset))
    try? FileManager.default.removeItem(at: dest)
    guard
      FileManager.default.createFile(
        atPath: dest.path, contents: nil, attributes: [.protectionKey: protection])
    else { throw CocoaError(.fileWriteUnknown) }
    let writer = try FileHandle(forWritingTo: dest)
    defer { try? writer.close() }
    var left = length
    while left > 0 {
      guard let data = try reader.read(upToCount: Int(min(left, 4 << 20))), !data.isEmpty else {
        throw CocoaError(.fileReadUnknown)
      }
      try writer.write(contentsOf: data)
      left -= Int64(data.count)
    }
  }

  private func fail(_ id: String, _ message: String) {
    log("upload \(id): \(message)")
    end(id, ["ok": false, "error": ["message": message, "canceled": false]])
  }

  private func end(_ id: String, _ fields: [String: Any]) {
    var message: [String: Any?] = ["type": "pulse.upload.end", "id": id]
    for (name, value) in fields { message[name] = value }
    send(message)
  }

  private func send(_ message: [String: Any?]) {
    DispatchQueue.main.async { BrownfieldMessaging.sendMessage(message) }
  }

  private func beginBackground(_ name: String) -> UIBackgroundTaskIdentifier {
    let begin = {
      UIApplication.shared.beginBackgroundTask(withName: name) {
        NSLog("[PulseKit] upload: background time ran out (%@)", name)
      }
    }
    return Thread.isMainThread ? begin() : DispatchQueue.main.sync(execute: begin)
  }

  private func endBackground(_ id: UIBackgroundTaskIdentifier) {
    guard id != .invalid else { return }
    DispatchQueue.main.async { UIApplication.shared.endBackgroundTask(id) }
  }

  private func log(_ line: String) {
    NSLog("[PulseKit] upload: %@", line)
  }
}
