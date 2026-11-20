import CryptoKit
import Foundation

// Accounts and namespaces (native-bridge.md §4, pulse-schema.md §6, C4, AD12). Every signed-in
// person gets a namespace of their own: a folder with its own library, catalog, results and media.
//
//   origin    = lowercase(scheme + "://" + host) + (non-default port ? ":" + port : "")
//   namespace = hostId + "-" + lowercaseHex(SHA256(UTF8(origin + "\n" + userId)))[0..<16]
//
// namespace-vectors.json (next to this file) holds five cases computed in Node; the owner checks
// on a device that this code gives the same namespaces. Foundation and CryptoKit only.

/// The origin rule. Strict on purpose, so Swift and the Node vectors can't disagree: http or https,
/// an ASCII host name or IPv4 address, an optional port 1–65535 (dropped when it is the scheme's
/// default), and whatever path, query or fragment follows is ignored. Credentials, IPv6 literals,
/// non-ASCII hosts (pass them punycoded), an empty port and surrounding spaces are refused.
public enum PulseOrigin {
  public static func normalise(_ serverOrigin: String) -> String? {
    let ascii = Array(serverOrigin.utf8)
    guard let sep = find(ascii, Array("://".utf8)) else { return nil }
    let schemeBytes = ascii[..<sep]
    guard let first = schemeBytes.first, isLetter(first),
      schemeBytes.allSatisfy({ isLetter($0) || isDigit($0) || "+.-".utf8.contains($0) })
    else { return nil }
    let scheme = String(decoding: schemeBytes, as: UTF8.self).lowercased()
    guard scheme == "http" || scheme == "https" else { return nil }
    let rest = ascii[(sep + 3)...]
    let authority = rest.prefix { !"/?#".utf8.contains($0) }
    var hostBytes = authority[...]
    var port: Int?
    if let colon = authority.firstIndex(of: UInt8(ascii: ":")) {
      hostBytes = authority[..<colon]
      let digits = authority[(colon + 1)...]
      guard (1...5).contains(digits.count), digits.allSatisfy(isDigit),
        let p = Int(String(decoding: digits, as: UTF8.self)), (1...65535).contains(p)
      else { return nil }
      port = p
    }
    guard !hostBytes.isEmpty,
      hostBytes.allSatisfy({ isLetter($0) || isDigit($0) || $0 == UInt8(ascii: ".") || $0 == UInt8(ascii: "-") }),
      hostBytes.contains(where: { isLetter($0) || isDigit($0) })
    else { return nil }
    let host = String(decoding: hostBytes, as: UTF8.self).lowercased()
    if port == (scheme == "http" ? 80 : 443) { port = nil }
    return scheme + "://" + host + (port.map { ":\($0)" } ?? "")
  }

  private static func isLetter(_ b: UInt8) -> Bool {
    (b >= UInt8(ascii: "a") && b <= UInt8(ascii: "z")) || (b >= UInt8(ascii: "A") && b <= UInt8(ascii: "Z"))
  }

  private static func isDigit(_ b: UInt8) -> Bool { b >= UInt8(ascii: "0") && b <= UInt8(ascii: "9") }

  private static func find(_ hay: [UInt8], _ needle: [UInt8]) -> Int? {
    guard hay.count >= needle.count else { return nil }
    for i in 0...(hay.count - needle.count) where Array(hay[i..<(i + needle.count)]) == needle {
      return i
    }
    return nil
  }
}

extension PulseNamespace {
  /// `<hostId>-<first 16 hex of SHA-256(origin + "\n" + userId)>`; `origin` is already normalised.
  public static func account(hostId: String, origin: String, userId: String) -> String {
    let digest = SHA256.hash(data: Data((origin + "\n" + userId).utf8))
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    return hostId + "-" + hex.prefix(16)
  }
}

/// `account.json` (native-bridge.md §6.4). It never holds the userId: the namespace is a hash so
/// that a folder name doesn't say whose it is.
struct PulseAccountFile: Codable, Equatable {
  var hostId: String
  var serverOrigin: String
  var label: String?
  var createdAt: Int64
  var lastUsedAt: Int64

  static let name = "account.json"

  static func read(in documents: URL) -> PulseAccountFile? {
    guard let data = try? Data(contentsOf: documents.appendingPathComponent(name)) else { return nil }
    return try? JSONDecoder().decode(PulseAccountFile.self, from: data)
  }

  func write(in documents: URL) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    try PulseKitStorage.writeAtomically(try encoder.encode(self), to: documents.appendingPathComponent(Self.name))
  }
}

/// The signed-in account and what `setAccount`, `listNamespaces` and the data calls see of it.
/// Main queue only (PulseKit's transport runs there).
final class PulseKitAccounts {
  struct Active: Equatable {
    var namespace: String
    var file: PulseAccountFile
  }

  /// nil before the first `setAccount` in this process and after `setAccount(null)`: data calls
  /// then fail with `no_account`.
  private(set) var active: Active?

  var namespace: String? { active?.namespace }

  enum Outcome: Equatable {
    case cleared
    /// The same namespace again: nothing changed.
    case unchanged(String)
    case switched(String)
    /// Switched, but Pulse's runtime is bound to another namespace: native reads answer for this
    /// one, while open (and anything Pulse JS answers) is `restart_required` until the app restarts.
    case restartRequired(String)
  }

  /// `setAccount(account | null)`. `{}` is the wire form of null.
  ///
  /// - A flow is open → `busy`: the open flow writes into the active namespace.
  /// - null → no active namespace (data calls → `no_account`); the runtime keeps its folders.
  /// - The same namespace → a no-op.
  /// - Otherwise it switches: folders, `account.json` (createdAt kept, lastUsedAt now).
  /// - When Pulse's runtime is bound to another namespace (`bound`), it still switches, so native
  ///   reads (the catalog) answer for the new person and never show the last person's drafts, but
  ///   the outcome is `.restartRequired`: the runtime's storage roots and open database are fixed
  ///   for its life (v1; X10 lifts this). Signing back in to the bound namespace is always fine.
  func set(
    _ args: [String: JSONValue], hostId: String, flowOpen: Bool, bound: String?, callId: String,
    now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
  ) -> Result<Outcome, PulseErrorInfo> {
    func fail(_ code: String, _ message: String) -> Result<Outcome, PulseErrorInfo> {
      .failure(PulseErrorInfo(code: code, message: message, callId: callId))
    }
    if flowOpen { return fail("busy", "Pulse is open; change the account after it closes.") }
    if args.values.allSatisfy({ $0 == .null }) {
      active = nil
      return .success(.cleared)
    }
    guard let serverOrigin = args["serverOrigin"]?.string, !serverOrigin.isEmpty else {
      return fail("invalid_options", "serverOrigin must be a non-empty string.")
    }
    guard let origin = PulseOrigin.normalise(serverOrigin) else {
      return fail(
        "invalid_options",
        "serverOrigin must be an http or https origin with an ASCII host, such as https://example.org.")
    }
    guard let userId = args["userId"]?.string, !userId.isEmpty else {
      return fail("invalid_options", "userId must be a non-empty string.")
    }
    var label: String?
    if let l = args["label"], l != .null {
      guard let s = l.string else { return fail("invalid_options", "label must be a string.") }
      label = s
    }
    let ns = PulseNamespace.account(hostId: hostId, origin: origin, userId: userId)
    if ns == active?.namespace {
      // A new label is still worth keeping: listNamespaces shows it.
      if let label, label != active?.file.label { _ = try? touch(label: label, now: now) }
      if let bound, bound != ns { return .success(.restartRequired(ns)) }
      return .success(.unchanged(ns))
    }
    let roots: PulseKitRoots
    do {
      roots = try PulseKitStorage.roots(ns)
    } catch {
      return fail("unknown", "Pulse's folders aren't available: \(error)")
    }
    let previous = PulseAccountFile.read(in: roots.documents)
    let file = PulseAccountFile(
      hostId: hostId, serverOrigin: origin, label: label, createdAt: previous?.createdAt ?? now,
      lastUsedAt: now)
    do {
      try file.write(in: roots.documents)
    } catch {
      return fail("unknown", "Pulse couldn't write account.json: \(error)")
    }
    active = Active(namespace: ns, file: file)
    if let bound, bound != ns { return .success(.restartRequired(ns)) }
    return .success(.switched(ns))
  }

  /// Make sure the active namespace's folders and `account.json` exist (a purge of the active
  /// namespace removes them; the person stays signed in) and return its roots.
  func activeRoots() throws -> PulseKitRoots? {
    guard let active else { return nil }
    let roots = try PulseKitStorage.roots(active.namespace)
    if PulseAccountFile.read(in: roots.documents) == nil { try active.file.write(in: roots.documents) }
    return roots
  }

  /// Record that the active namespace was used now (an open), and keep a new label.
  @discardableResult
  func touch(label: String?? = .none, now: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) throws
    -> Bool
  {
    guard var a = active, let roots = try activeRoots() else { return false }
    a.file.lastUsedAt = now
    if case .some(let l) = label { a.file.label = l }
    try a.file.write(in: roots.documents)
    active = a
    return true
  }

  // MARK: - listNamespaces

  /// `listNamespaces()`: every namespace folder with an `account.json`, plus PR1's `<hostId>-local`
  /// folders (no account.json; reported so the host can see and clean them up). Oldest use first
  /// is the host's business: this answers in name order.
  func list(net: PulseNetworkView) -> [JSONValue] {
    guard let lib = try? PulseKitStorage.libraryRoot() else { return [] }
    return PulseKitStorage.namespaceNames().compactMap { name -> JSONValue? in
      let documents = lib.appendingPathComponent(name, isDirectory: true)
      let file = PulseAccountFile.read(in: documents)
      let local = file == nil && name.hasSuffix(PulseKitStorage.localSuffix)
      guard file != nil || local else { return nil }
      let unsent: Int
      if let catalog = PulseCatalog.read(in: documents) {
        unsent = PulseCatalog.counts(catalog, net).unsent
      } else {
        unsent = PulseKitStorage.draftFolders(in: documents)
      }
      var o: [String: JSONValue] = [
        "namespace": .string(name),
        "hostId": .string(file?.hostId ?? String(name.dropLast(PulseKitStorage.localSuffix.count))),
        "serverOrigin": .string(file?.serverOrigin ?? ""),
        "bytes": .int(PulseKitStorage.bytes(of: name)),
        "unsent": .int(Int64(unsent)),
        "lastUsedAt": .int(file?.lastUsedAt ?? PulseKitStorage.modifiedAt(documents)),
        "active": .bool(name == namespace),
      ]
      if let label = file?.label { o["label"] = .string(label) }
      return .object(o)
    }
  }

  // MARK: - PR1's `-local` namespace

  /// PR1 kept everything in `<hostId>-local`. It is never adopted into a signed-in account (a
  /// shared phone could hand one person's drafts to another): when empty it is deleted; when not,
  /// it stays, listed by listNamespaces, for the host's stale-namespace cleanup (purge).
  /// `except` is a namespace the runtime is bound to, which is never touched.
  static func removeEmptyLocalNamespaces(except: String?) -> [String] {
    guard let lib = try? PulseKitStorage.libraryRoot() else { return [] }
    var removed: [String] = []
    for name in PulseKitStorage.namespaceNames()
    where name.hasSuffix(PulseKitStorage.localSuffix) && name != except {
      let documents = lib.appendingPathComponent(name, isDirectory: true)
      guard PulseAccountFile.read(in: documents) == nil, PulseKitStorage.isEmpty(documents: documents)
      else { continue }
      do {
        try PulseKitStorage.remove(namespace: name)
        removed.append(name)
      } catch {
        NSLog("[PulseKit] couldn't remove the empty namespace %@: %@", name, "\(error)")
      }
    }
    return removed
  }
}
