import Foundation

// The facade's catalog reader (native-bridge.md §6.1): listDrafts, getDraft, countDrafts and the
// row counts behind usage, answered from catalog.json without starting Pulse's runtime.
//
// The rules are src/features/drafts/catalog-filter.ts, rule for rule. Both run the shared vectors
// in src/features/drafts/__vectors__/catalog.json, so the two can't drift. This file is
// Foundation only (no UIKit, no React, not even the facade's JSONValue), so it compiles alone
// into a macOS command-line binary with tests/CatalogVectorsMain.swift:
//
//   xcrun swiftc -o "$TMPDIR/pk-catalog-vectors" \
//     embed/native/ios/PulseKitCatalog.swift embed/native/ios/tests/CatalogVectorsMain.swift
//   "$TMPDIR/pk-catalog-vectors" src/features/drafts/__vectors__/catalog.json
//
// Rows stay Foundation values ([String: Any], as JSONSerialization makes them) and pass through
// whole: a field this reader doesn't know reaches the host unchanged. Text compares by UTF-16 code
// unit, as JavaScript's `===`, `<` and `startsWith` do; Swift's own String comparison treats
// canonically equivalent text as equal, which TypeScript doesn't.

/// What the reader knows about the network, and the host's Wi-Fi-only choice (`NetworkView`).
public struct PulseNetworkView: Equatable {
  public var online: Bool
  public var wifi: Bool
  public var wifiOnlyUploads: Bool

  public init(online: Bool, wifi: Bool, wifiOnlyUploads: Bool) {
    self.online = online
    self.wifi = wifi
    self.wifiOnlyUploads = wifiOnlyUploads
  }
}

public enum PulseCatalog {
  public typealias Row = [String: Any]

  /// The catalog's name under the namespace's documents root, and where each write goes first.
  public static let file = "catalog.json"
  public static let part = "catalog.json.part"

  /// Every state but 'sent': listDrafts' and countDrafts' default.
  public static let unsent: [String] = [
    "draft", "ready", "preparing", "queued", "waiting_network", "uploading", "delivering",
    "needs_credentials", "failed",
  ]

  /// Shown states that count as uploading in `usage` (the fake's rule, PR2-K).
  public static let uploadingStates: Set<String> = [
    "preparing", "queued", "waiting_network", "uploading", "delivering",
  ]

  /// A parsed `catalog.json`. Unknown top-level fields are kept in `raw`.
  public struct Catalog {
    public var raw: [String: Any]
    public var drafts: [Row]
    public var receipts: [Row]

    /// Written by a newer schema. The facade passes it on and refuses nothing for it: such a
    /// library still lists, sends and deletes (PLAN-final AD34); Pulse JS refuses only edits.
    public var readOnly: Bool { raw["readOnly"] as? Bool ?? false }
    public var writtenAt: Double? { number(raw["writtenAt"]) }

    public static let empty = Catalog(raw: [:], drafts: [], receipts: [])
  }

  // MARK: - Reading

  /// `data` as a catalog, or nil when it isn't one (missing, cut short, or another file).
  public static func parse(_ data: Data?) -> Catalog? {
    guard let data,
      let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
      let top = object as? [String: Any],
      top["format"] as? String == "pulse-catalog",
      number(top["version"]) != nil,
      let drafts = top["drafts"] as? [Any],
      let receipts = top["receipts"] as? [Any]
    else { return nil }
    return Catalog(
      raw: top, drafts: drafts.compactMap { $0 as? Row }, receipts: receipts.compactMap { $0 as? Row })
  }

  /// How a reader finds the catalog (catalog-filter.ts `readCatalogFile`). `read(name)` returns the
  /// file's bytes, or nil when there's no such file. In order: `catalog.json`; when it's missing,
  /// `catalog.json.part` (the writer's move deletes the old file before moving the `.part` in); and
  /// when that is missing or cut short, `catalog.json` once more (the move landed in between).
  /// Nothing that parses means no catalog: the reader answers as if it were empty.
  public static func read(_ read: (String) -> Data?) -> Catalog? {
    parse(read(file)) ?? parse(read(part)) ?? parse(read(file))
  }

  /// The catalog in a namespace's documents root, or nil.
  public static func read(in dir: URL) -> Catalog? {
    read { name in try? Data(contentsOf: dir.appendingPathComponent(name)) }
  }

  // MARK: - Arguments

  /// `DraftFilter`.
  public struct Filter {
    public var contextKey: String?
    public var contextKeyPrefix: String?
    public var contextKind: String?
    /// Default: every state but 'sent'.
    public var states: [String]?

    public init(
      contextKey: String? = nil, contextKeyPrefix: String? = nil, contextKind: String? = nil,
      states: [String]? = nil
    ) {
      self.contextKey = contextKey
      self.contextKeyPrefix = contextKeyPrefix
      self.contextKind = contextKind
      self.states = states
    }

    /// From a call's args; `.failure` carries the message for `invalid_options`. A null field is
    /// the same as a missing one; unknown fields are ignored.
    public static func from(_ args: [String: Any]) -> Result<Filter, ArgsProblem> {
      do {
        return .success(
          Filter(
            contextKey: try optionalString(args, "contextKey"),
            contextKeyPrefix: try optionalString(args, "contextKeyPrefix"),
            contextKind: try optionalString(args, "contextKind"),
            states: try optionalStates(args)))
      } catch let problem as ArgsProblem {
        return .failure(problem)
      } catch {
        return .failure(ArgsProblem(message: "\(error)"))
      }
    }
  }

  /// `CountOptions`.
  public struct CountOptions {
    public enum By: String { case contextKey, contextKind }
    public var by: By
    /// Only rows that need the person: 'failed', and 'sent' kept by the server and not dismissed.
    public var attentionOnly: Bool
    public var states: [String]?

    public init(by: By, attentionOnly: Bool = false, states: [String]? = nil) {
      self.by = by
      self.attentionOnly = attentionOnly
      self.states = states
    }

    public static func from(_ args: [String: Any]) -> Result<CountOptions, ArgsProblem> {
      guard let raw = args["by"] as? String, let by = By(rawValue: raw) else {
        return .failure(ArgsProblem(message: "by must be 'contextKey' or 'contextKind'."))
      }
      var attentionOnly = false
      switch args["attentionOnly"] {
      case nil, is NSNull: break
      case let b as NSNumber where isBool(b): attentionOnly = b.boolValue
      default: return .failure(ArgsProblem(message: "attentionOnly must be a boolean."))
      }
      do {
        return .success(
          CountOptions(by: by, attentionOnly: attentionOnly, states: try optionalStates(args)))
      } catch let problem as ArgsProblem {
        return .failure(problem)
      } catch {
        return .failure(ArgsProblem(message: "\(error)"))
      }
    }
  }

  public struct ArgsProblem: Error, Equatable {
    public var message: String
  }

  private static func optionalString(_ args: [String: Any], _ key: String) throws -> String? {
    switch args[key] {
    case nil, is NSNull: return nil
    case let s as String: return s
    default: throw ArgsProblem(message: "\(key) must be a string.")
    }
  }

  private static func optionalStates(_ args: [String: Any]) throws -> [String]? {
    switch args["states"] {
    case nil, is NSNull: return nil
    case let list as [Any]:
      return try list.map {
        guard let s = $0 as? String else { throw ArgsProblem(message: "states must be strings.") }
        return s
      }
    default: throw ArgsProblem(message: "states must be an array.")
    }
  }

  // MARK: - Rules (catalog-filter.ts)

  /// The state the host sees: a queued upload waits for the network while there is none, or while
  /// uploads wait for Wi-Fi and there's no Wi-Fi. The catalog never stores `waiting_network`.
  public static func shownState(_ state: String?, _ net: PulseNetworkView) -> String? {
    guard state == "queued" else { return state }
    return !net.online || (net.wifiOnlyUploads && !net.wifi) ? "waiting_network" : "queued"
  }

  /// The catalog's order: the newest change first, equal times by id (ascending, by UTF-16 code
  /// unit). True when `a` comes before `b`.
  public static func before(_ a: Row, _ b: Row) -> Bool {
    // `b.updatedAt - a.updatedAt || idOrder`: a missing time is NaN, and NaN falls to the id.
    let d = (number(b["updatedAt"]) ?? .nan) - (number(a["updatedAt"]) ?? .nan)
    if d != 0 && !d.isNaN { return d < 0 }
    guard let x = a["id"] as? String, let y = b["id"] as? String else { return false }
    return x.utf16.lexicographicallyPrecedes(y.utf16)
  }

  /// The catalog's rows in the states asked for, with their shown state, in catalog order.
  /// JavaScript's sort is stable, so rows the order can't tell apart keep their file order.
  static func rows(_ catalog: Catalog, states: [String], _ net: PulseNetworkView) -> [Row] {
    let wanted = Set(states)
    let all = wanted.contains("sent") ? catalog.drafts + catalog.receipts : catalog.drafts
    let shown = all.compactMap { row -> Row? in
      var r = row
      let state = shownState(row["state"] as? String, net)
      r["state"] = state
      return state.map(wanted.contains) == true ? r : nil
    }
    return shown.enumerated().sorted { x, y in
      if before(x.element, y.element) { return true }
      if before(y.element, x.element) { return false }
      return x.offset < y.offset
    }.map(\.element)
  }

  private static func context(_ row: Row) -> [String: Any]? { row["context"] as? [String: Any] }

  /// `listDrafts(filter)`: rows in the asked states for the asked place, newest change first.
  public static func listDrafts(_ catalog: Catalog, _ filter: Filter, _ net: PulseNetworkView)
    -> [Row]
  {
    rows(catalog, states: filter.states ?? unsent, net).filter { row in
      let key = context(row)?["key"] as? String
      if let want = filter.contextKey, !same(key, want) { return false }
      if let prefix = filter.contextKeyPrefix {
        guard let key, key.utf16.starts(with: prefix.utf16) else { return false }
      }
      if let want = filter.contextKind, !same(context(row)?["kind"] as? String, want) {
        return false
      }
      return true
    }
  }

  /// `getDraft(id)`: the row with that id, a draft or a receipt, with its shown state.
  public static func getDraft(_ catalog: Catalog, id: String, _ net: PulseNetworkView) -> Row? {
    guard
      var row = (catalog.drafts + catalog.receipts).first(where: { same($0["id"] as? String, id) })
    else { return nil }
    row["state"] = shownState(row["state"] as? String, net)
    return row
  }

  /// Whether a row needs the person: its upload failed, or the server kept it and they haven't
  /// seen it.
  public static func needsAttention(_ row: Row) -> Bool {
    let state = row["state"] as? String
    if state == "failed" { return true }
    guard state == "sent", let sent = row["sent"] as? [String: Any] else { return false }
    return sent["outcome"] as? String == "kept" && !truthy(sent["dismissed"])
  }

  /// `countDrafts(options)`: how many rows each place (`.contextKey`) or kind of place
  /// (`.contextKind`) has, in the asked states (default every state but 'sent'), or with
  /// `attentionOnly` only those that need the person. Rows without a place aren't counted; places
  /// with none are left out. Groups are told apart by UTF-16 code unit, in first-seen order.
  public static func countDrafts(
    _ catalog: Catalog, _ options: CountOptions, _ net: PulseNetworkView
  ) -> [(key: String, count: Int)] {
    let states = options.states ?? (options.attentionOnly ? unsent + ["sent"] : unsent)
    var order: [String] = []
    var counts: [[UInt16]: Int] = [:]
    for row in rows(catalog, states: states, net) {
      guard let ctx = context(row) else { continue }
      if options.attentionOnly && !needsAttention(row) { continue }
      let field = options.by == .contextKind ? "kind" : "key"
      guard let group = ctx[field] as? String else { continue }
      let id = Array(group.utf16)
      if counts[id] == nil { order.append(group) }
      counts[id, default: 0] += 1
    }
    return order.map { ($0, counts[Array($0.utf16)] ?? 0) }
  }

  /// The row counts `usage` reports (the bytes come from the folders).
  public struct Counts: Equatable {
    public var drafts = 0
    /// Every state but 'sent'. The kill switch keeps Pulse reachable while > 0 (AD25).
    public var unsent = 0
    public var uploading = 0
    public var failed = 0
    public var receipts = 0
  }

  public static func counts(_ catalog: Catalog, _ net: PulseNetworkView) -> Counts {
    var c = Counts()
    for row in catalog.drafts {
      c.drafts += 1
      c.unsent += 1
      let state = shownState(row["state"] as? String, net) ?? ""
      if uploadingStates.contains(state) { c.uploading += 1 }
      if state == "failed" { c.failed += 1 }
    }
    c.receipts = catalog.receipts.count
    return c
  }

  // MARK: - JavaScript's comparisons

  /// `a === b` for strings: the same UTF-16 code units (Swift's `==` also matches canonically
  /// equivalent text, such as a precomposed and a decomposed "é").
  static func same(_ a: String?, _ b: String) -> Bool {
    guard let a else { return false }
    return a.utf16.elementsEqual(b.utf16)
  }

  /// A JSON number (never a boolean, which Foundation also hands over as an NSNumber).
  static func number(_ v: Any?) -> Double? {
    guard let n = v as? NSNumber, !isBool(n) else { return nil }
    return n.doubleValue
  }

  static func isBool(_ v: Any) -> Bool {
    guard let n = v as? NSNumber else { return false }
    return CFGetTypeID(n as CFTypeRef) == CFBooleanGetTypeID()
  }

  /// JavaScript truthiness of a JSON value.
  static func truthy(_ v: Any?) -> Bool {
    switch v {
    case nil, is NSNull: return false
    case let n as NSNumber:
      if isBool(n) { return n.boolValue }
      let d = n.doubleValue
      return d != 0 && !d.isNaN
    case let s as String: return !s.isEmpty
    default: return true
    }
  }
}
