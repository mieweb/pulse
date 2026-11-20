import Foundation

// The facade's pure rules: envelopes, routing, the open gate, inbox order and the PR1 namespace.
// Foundation only (no UIKit, no React), so it compiles alone into a macOS command-line binary
// that runs the shared vectors in vectors/envelope.json (tests/EnvelopeVectorsMain.swift).
// native-bridge.md §2, §3 and §6.2 are the contract this file implements.

// MARK: - Contract

/// The contract this facade speaks (pulse-embed.d.ts, AD18).
public enum PulseContract {
  public static let major = 1
  /// Minor 1: PR2's data API (`minor1Methods`), what the JS client's CONTRACT says too.
  public static let minor = 1
  /// The envelope version, always 1 in contract major 1.
  public static let envelopeVersion = 1

  /// Methods the facade answers itself in contract minor 0 (PR1).
  public static let nativeMethods: [String] = [
    "info", "configure", "prewarm", "open", "close", "isOpen", "pendingResults", "acknowledge",
    "logFile",
  ]

  /// Methods contract minor 1 (PR2) adds. This facade doesn't list them yet, so they are
  /// `method.unsupported` here, the same as a name nobody knows.
  public static let minor1Methods: [String] = [
    "setAccount", "listDrafts", "getDraft", "countDrafts", "renameDraft", "deleteDraft",
    "setDraftContext", "upload", "cancelUpload", "retireDraft", "dismissReceipt", "resumeOutbox",
    "usage", "listNamespaces", "purge", "respondHostRequest",
  ]

  /// Entries `open` accepts.
  public static let entries: [String] = ["record", "edit", "export"]
}

// MARK: - JSON values

/// Any JSON value. Integers stay integers through a round trip (times are integer milliseconds).
public enum JSONValue: Codable, Equatable {
  case null
  case bool(Bool)
  case int(Int64)
  case double(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let i = try? c.decode(Int64.self) {
      self = .int(i)
    } else if let d = try? c.decode(Double.self) {
      self = .double(d)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([JSONValue].self) {
      self = .array(a)
    } else {
      self = .object(try c.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .int(let i): try c.encode(i)
    case .double(let d): try c.encode(d)
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }

  /// Parse JSON text; nil when it isn't JSON.
  public static func parse(_ text: String) -> JSONValue? {
    try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
  }

  /// Compact JSON with sorted keys, so the same value always prints the same text.
  public var serialized: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(self) else { return "null" }
    return String(decoding: data, as: UTF8.self)
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let o) = self { return o[key] }
    return nil
  }

  public var object: [String: JSONValue]? {
    if case .object(let o) = self { return o }
    return nil
  }

  public var string: String? {
    if case .string(let s) = self { return s }
    return nil
  }

  public var bool: Bool? {
    if case .bool(let b) = self { return b }
    return nil
  }

  public var array: [JSONValue]? {
    if case .array(let a) = self { return a }
    return nil
  }

  /// A whole number, from an integer or a double without a fraction.
  public var integer: Int64? {
    switch self {
    case .int(let i): return i
    case .double(let d) where d.rounded() == d && abs(d) < 9.0e15: return Int64(d)
    default: return nil
    }
  }

  /// From what JSONSerialization or BrownfieldMessaging hands over (`[String: Any?]` and friends).
  /// Values JSON can't hold become null.
  public init(any: Any?) {
    guard let any else {
      self = .null
      return
    }
    switch any {
    case is NSNull:
      self = .null
    case let n as NSNumber:
      if CFGetTypeID(n as CFTypeRef) == CFBooleanGetTypeID() {
        self = .bool(n.boolValue)
      } else if CFNumberIsFloatType(n as CFNumber) {
        self = .double(n.doubleValue)
      } else {
        self = .int(n.int64Value)
      }
    case let s as String:
      self = .string(s)
    case let a as [Any?]:
      self = .array(a.map { JSONValue(any: $0) })
    case let a as [Any]:
      self = .array(a.map { JSONValue(any: $0) })
    case let o as [String: Any?]:
      self = .object(o.mapValues { JSONValue(any: $0) })
    case let o as [String: Any]:
      self = .object(o.mapValues { JSONValue(any: $0) })
    default:
      self = .null
    }
  }

  /// For APIs that take Foundation values: initial props and BrownfieldMessaging.
  public var foundation: Any {
    switch self {
    case .null: return NSNull()
    case .bool(let b): return b
    case .int(let i): return i
    case .double(let d): return d
    case .string(let s): return s
    case .array(let a): return a.map(\.foundation)
    case .object(let o): return o.mapValues(\.foundation)
    }
  }
}

// MARK: - Errors

/// `PulseErrorInfo` (pulse-embed.d.ts). `message` is English, for logs only.
public struct PulseErrorInfo: Codable, Equatable, Error {
  public var code: String
  public var message: String
  public var recoverable: Bool
  public var callId: String
  public var requestId: String?
  public var draftId: String?
  public var uploadId: String?
  public var details: JSONValue?

  public init(
    code: String, message: String, callId: String, requestId: String? = nil,
    recoverable: Bool? = nil, details: JSONValue? = nil
  ) {
    self.code = code
    self.message = message
    self.recoverable = recoverable ?? PulseErrorInfo.isRecoverable(code)
    self.callId = callId
    self.requestId = requestId
    self.details = details
  }

  /// True when the same call may succeed later without a change by the person.
  public static func isRecoverable(_ code: String) -> Bool {
    ["busy", "timeout", "host.unavailable", "runtime.error", "upload.failed"].contains(code)
  }

  public var json: JSONValue {
    var o: [String: JSONValue] = [
      "code": .string(code), "message": .string(message), "recoverable": .bool(recoverable),
      "callId": .string(callId),
    ]
    if let requestId { o["requestId"] = .string(requestId) }
    if let draftId { o["draftId"] = .string(draftId) }
    if let uploadId { o["uploadId"] = .string(uploadId) }
    if let details { o["details"] = details }
    return .object(o)
  }
}

// MARK: - Envelopes

/// A request envelope (§2.1). Unknown fields, at the top and inside `args`, are ignored.
public struct PulseRequest: Codable, Equatable {
  public struct Client: Codable, Equatable {
    public struct Contract: Codable, Equatable {
      public var major: Int
      public var minor: Int?
    }
    public var contract: Contract?
    public var version: String?
  }

  public var v: Int
  public var callId: String
  public var method: String
  public var args: [String: JSONValue]
  public var client: Client?
  /// How long the client waits for the reply, in ms (a positive whole number, else ignored): a
  /// call forwarded to Pulse JS waits as long before it answers `timeout`.
  public var timeoutMs: Int? = nil
}

/// A reply envelope (§2.2). Every call gets exactly one; a Pulse error is `ok: false`.
public struct PulseReply: Codable, Equatable {
  public var v: Int
  public var callId: String
  public var ok: Bool
  public var result: JSONValue?
  public var error: PulseErrorInfo?

  public static func success(_ callId: String, _ result: JSONValue = .null) -> PulseReply {
    PulseReply(v: PulseContract.envelopeVersion, callId: callId, ok: true, result: result, error: nil)
  }

  public static func failure(_ error: PulseErrorInfo) -> PulseReply {
    PulseReply(
      v: PulseContract.envelopeVersion, callId: error.callId, ok: false, result: nil, error: error)
  }

  public static func failure(
    _ code: String, _ message: String, callId: String, requestId: String? = nil
  ) -> PulseReply {
    failure(PulseErrorInfo(code: code, message: message, callId: callId, requestId: requestId))
  }

  private enum Keys: String, CodingKey { case v, callId, ok, result, error }

  public init(v: Int, callId: String, ok: Bool, result: JSONValue?, error: PulseErrorInfo?) {
    self.v = v
    self.callId = callId
    self.ok = ok
    self.result = result
    self.error = error
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    v = try c.decode(Int.self, forKey: .v)
    callId = try c.decode(String.self, forKey: .callId)
    ok = try c.decode(Bool.self, forKey: .ok)
    // A `null` result decodes as .null, not as a missing one: `void` methods answer null.
    result = c.contains(.result) ? try c.decode(JSONValue.self, forKey: .result) : nil
    error = try c.decodeIfPresent(PulseErrorInfo.self, forKey: .error)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: Keys.self)
    try c.encode(v, forKey: .v)
    try c.encode(callId, forKey: .callId)
    try c.encode(ok, forKey: .ok)
    if ok {
      try c.encode(result ?? .null, forKey: .result)
    } else {
      try c.encode(error?.json ?? .null, forKey: .error)
    }
  }

  public var serialized: String { Self.encode(self) }

  static func encode<T: Encodable>(_ value: T) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value) else { return "{}" }
    return String(decoding: data, as: UTF8.self)
  }
}

/// An event envelope (§2.3).
public struct PulseEvent: Codable, Equatable {
  public var v: Int = PulseContract.envelopeVersion
  public var name: String
  public var payload: JSONValue

  public init(name: String, payload: JSONValue) {
    self.name = name
    self.payload = payload
  }

  public var serialized: String { PulseReply.encode(self) }
}

// MARK: - Routing

public enum PulseRoute: Equatable {
  /// The facade answers this request itself.
  case native(PulseRequest)
  /// The request ends here with this reply.
  case reply(PulseReply)
}

public enum PulseRouter {
  /// Decide what happens to one request envelope. `supported` is `info().supported`: when it is
  /// false every method except `info` is `unsupported`. `methods` are the ones the facade answers
  /// (default: contract minor 0's); any other is `method.unsupported`.
  public static func route(
    _ text: String, supported: Bool = true, methods: [String] = PulseContract.nativeMethods
  ) -> PulseRoute {
    guard let value = JSONValue.parse(text), let top = value.object else {
      return .reply(.failure("invalid_options", "The request isn't a JSON object.", callId: ""))
    }
    guard let callId = top["callId"]?.string, !callId.isEmpty else {
      return .reply(.failure("invalid_options", "The request has no callId.", callId: ""))
    }
    func fail(_ code: String, _ message: String) -> PulseRoute {
      .reply(.failure(code, message, callId: callId))
    }
    guard let v = top["v"]?.integer else {
      return fail("invalid_options", "The request has no envelope version (v).")
    }
    guard v == Int64(PulseContract.envelopeVersion) else {
      return fail("contract.unsupported", "Envelope version \(v) isn't supported; this facade speaks 1.")
    }
    var client: PulseRequest.Client?
    if let c = top["client"] {
      guard c.object != nil else { return fail("invalid_options", "client must be an object.") }
      var contract: PulseRequest.Client.Contract?
      if let k = c["contract"] {
        guard let major = k["major"]?.integer else {
          return fail("invalid_options", "client.contract.major must be a number.")
        }
        guard major == Int64(PulseContract.major) else {
          return fail(
            "contract.unsupported",
            "The client speaks contract major \(major); this facade speaks \(PulseContract.major).")
        }
        contract = .init(major: Int(major), minor: k["minor"]?.integer.map { Int($0) })
      }
      client = .init(contract: contract, version: c["version"]?.string)
    }
    guard let method = top["method"]?.string, !method.isEmpty else {
      return fail("invalid_options", "The request has no method.")
    }
    var args: [String: JSONValue] = [:]
    if let a = top["args"] {
      switch a {
      case .null: break
      case .object(let o): args = o
      default: return fail("invalid_options", "args must be an object.")
      }
    }
    guard methods.contains(method) else {
      return fail("method.unsupported", "This PulseKit doesn't answer \(method).")
    }
    if !supported && method != "info" {
      return fail("unsupported", "Pulse doesn't run on this device.")
    }
    var timeoutMs: Int?
    if let t = top["timeoutMs"]?.integer, t > 0, t <= Int64(Int32.max) { timeoutMs = Int(t) }
    return .native(
      PulseRequest(
        v: Int(v), callId: callId, method: method, args: args, client: client,
        timeoutMs: timeoutMs))
  }
}

// MARK: - Arguments

/// A plain file-name-safe id: 1–64 of `[A-Za-z0-9._-]`, never `.` or `..`. Request ids and
/// namespaces become file and folder names, so nothing else gets near the file system.
public func pulseIsPlainName(_ s: String) -> Bool {
  !s.isEmpty && s.utf8.count <= 64 && s != "." && s != ".."
    && s.unicodeScalars.allSatisfy {
      ($0.isASCII && CharacterSet.alphanumerics.contains($0)) || "._-".unicodeScalars.contains($0)
    }
}

/// `open`'s arguments after the facade's checks. The rest of the request goes to Pulse JS whole.
public struct PulseOpenArgs: Equatable {
  /// The caller's idempotency key; nil means "make one".
  public var requestId: String?
  public var entry: String
  public var request: [String: JSONValue]
}

public enum PulseArgs {
  /// Check `open` before anything is presented: a bad request fails without a screen.
  public static func open(_ args: [String: JSONValue], callId: String) -> Result<
    PulseOpenArgs, PulseErrorInfo
  > {
    func bad(_ message: String) -> Result<PulseOpenArgs, PulseErrorInfo> {
      .failure(PulseErrorInfo(code: "invalid_options", message: message, callId: callId))
    }
    var requestId: String?
    if let r = args["requestId"], r != .null {
      guard let s = r.string, pulseIsPlainName(s) else {
        return bad("requestId must be 1–64 letters, digits, dots, dashes or underscores.")
      }
      requestId = s
    }
    guard let entry = args["entry"]?.string else { return bad("open needs an entry.") }
    guard PulseContract.entries.contains(entry) else {
      return bad("Pulse has no entry named \(entry).")
    }
    if let t = args["theme"], t != .null, t.object == nil {
      return bad("theme must be an object.")
    }
    switch entry {
    case "record":
      guard let context = args["context"], let key = context["key"]?.string, !key.isEmpty else {
        return bad("record needs a context with a key.")
      }
      if let d = args["draft"], d != .null {
        let isNew = d.string == "new"
        let continues = d["continue"]?.string.map { !$0.isEmpty } ?? false
        guard isNew || continues else {
          return bad("draft must be 'new' or { continue: draftId }.")
        }
      }
    default:
      guard let id = args["draftId"]?.string, !id.isEmpty else {
        return bad("\(entry) needs a draftId.")
      }
    }
    return .success(PulseOpenArgs(requestId: requestId, entry: entry, request: args))
  }

  /// `configure`: checks only what the facade itself uses; Pulse JS reads the rest.
  public static func configure(_ args: [String: JSONValue], callId: String) -> PulseErrorInfo? {
    func bad(_ message: String) -> PulseErrorInfo {
      PulseErrorInfo(code: "invalid_options", message: message, callId: callId)
    }
    if let h = args["hostId"], h != .null {
      guard let s = h.string, PulseNamespace.isValidHostId(s) else {
        return bad("hostId must be 1–40 of a-z, 0-9, dots and dashes.")
      }
    }
    if let m = args["uploadMode"], m != .null {
      guard let s = m.string, ["pulse", "file"].contains(s) else {
        return bad("uploadMode must be 'pulse' or 'file'.")
      }
    }
    for key in ["policy", "theme", "models"] {
      if let v = args[key], v != .null, v.object == nil { return bad("\(key) must be an object.") }
    }
    return nil
  }
}

// MARK: - One flow at a time (§3 busy matrix)

public enum PulsePresenterState: String {
  /// The plugin passed no view controller.
  case none
  /// The view controller can present.
  case idle
  /// It is already presenting something.
  case presenting
  /// It isn't in a window (not on screen yet, or already removed), so `present` would fail with
  /// only a UIKit warning and the `open` reply would never come.
  case detached
}

public enum PulseOpenDecision: String {
  /// Present a new flow.
  case start
  /// The same requestId is open: wait for the same result.
  case join
  /// Another flow is open, or the host is showing another screen.
  case busy
  /// There is nothing to present from.
  case noPresenter
  /// This requestId already ended and its result is still in the inbox (not acknowledged):
  /// answer with that result and present nothing. A new flow under the same id would be answered
  /// with the old file, and its own result would replace one the host hasn't seen.
  case delivered
}

public enum PulseOpenGate {
  /// The open flow comes first: its own presentation makes the presenter look busy, and the same
  /// requestId must still join it. Then an unacknowledged result for the requestId (`pending`)
  /// answers the open, whatever the presenter is doing, since nothing is presented.
  public static func decide(
    openRequestId: String?, requestId: String?, presenter: PulsePresenterState,
    pending: Bool = false
  ) -> PulseOpenDecision {
    if let open = openRequestId { return requestId == open ? .join : .busy }
    if pending, requestId != nil { return .delivered }
    switch presenter {
    case .none: return .noPresenter
    case .presenting, .detached: return .busy
    case .idle: return .start
    }
  }
}

// MARK: - Results inbox order (§6.2)

public struct PulseInboxEntry {
  public var name: String
  /// Modification time, seconds since 1970.
  public var modified: Double

  public init(name: String, modified: Double) {
    self.name = name
    self.modified = modified
  }
}

public enum PulseInboxOrder {
  /// Request ids of the result files in `results/`, oldest first: every `<id>.json` except
  /// `<id>.project.json` (the project document next to a file-mode export). Ties go by name, so
  /// the order is stable.
  public static func pending(_ entries: [PulseInboxEntry]) -> [String] {
    var results: [(id: String, modified: Double)] = []
    for entry in entries
    where entry.name.hasSuffix(".json") && !entry.name.hasSuffix(".project.json") {
      let id = String(entry.name.dropLast(5))
      if pulseIsPlainName(id) { results.append((id, entry.modified)) }
    }
    results.sort { a, b in a.modified != b.modified ? a.modified < b.modified : a.id < b.id }
    return results.map { $0.id }
  }

  /// The files `acknowledge(requestId)` deletes.
  public static func files(for requestId: String) -> [String] {
    [".json", ".mp4", ".project.json"].map { requestId + $0 }
  }
}

// MARK: - Namespace (PR1)

public enum PulseNamespace {
  /// `ConfigureOptions.hostId`: 1–40 of `[a-z0-9.-]` with at least one letter or digit.
  public static func isValidHostId(_ s: String) -> Bool {
    !s.isEmpty && s.utf8.count <= 40
      && s.unicodeScalars.allSatisfy { allowed.contains($0) }
      && s.unicodeScalars.contains { CharacterSet.alphanumerics.contains($0) }
  }

  /// The default hostId from a bundle id: lowercased, anything outside `[a-z0-9.-]` becomes
  /// `-`, at most 40 characters, no leading or trailing dot or dash.
  public static func sanitise(_ bundleId: String) -> String {
    let mapped = String(
      String.UnicodeScalarView(
        bundleId.lowercased().unicodeScalars.map { allowed.contains($0) ? $0 : "-" }))
    let trimmed = String(mapped.prefix(40)).trimmingCharacters(in: CharacterSet(charactersIn: ".-"))
    return isValidHostId(trimmed) ? trimmed : "host"
  }

  /// PR1 has no accounts: everything lives in `<hostId>-local` until PR2's setAccount.
  public static func local(hostId: String) -> String { hostId + "-local" }

  private static let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.-")
}
