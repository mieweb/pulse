import Foundation

// Runs src/features/drafts/__vectors__/catalog.json against PulseKitCatalog.swift, on a Mac, with
// no iOS build:
//
//   xcrun swiftc -o "$TMPDIR/pk-catalog-vectors" \
//     embed/native/ios/PulseKitCatalog.swift embed/native/ios/tests/CatalogVectorsMain.swift
//   "$TMPDIR/pk-catalog-vectors" src/features/drafts/__vectors__/catalog.json
//
// The shared sections (listDrafts, countDrafts, shownState, readCatalog) are the ones
// catalog-filter.test.ts runs in jest. The `facade:` checks after them pin what only the Swift
// reader does (getDraft, usage's counts, argument checks, UTF-16 comparisons), against the same
// catalog. Prints one line per check and exits 1 if any fails.

@main
struct CatalogVectors {
  static var passed = 0
  static var failed = 0

  static func check(_ ok: Bool, _ name: String, _ detail: @autoclosure () -> String = "") {
    if ok {
      passed += 1
      print("ok      \(name)")
    } else {
      failed += 1
      print("FAILED  \(name): \(detail())")
    }
  }

  static func main() {
    guard CommandLine.arguments.count == 2,
      let data = FileManager.default.contents(atPath: CommandLine.arguments[1]),
      let vectors = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else {
      print("usage: pk-catalog-vectors <path to catalog.json vectors>")
      exit(2)
    }
    check(
      vectors["format"] as? String == "pulse-catalog-vectors"
        && (vectors["version"] as? NSNumber)?.intValue == 1,
      "format: the vectors file this reader knows")
    guard let catalogObject = vectors["catalog"],
      let catalog = PulseCatalog.parse(try? JSONSerialization.data(withJSONObject: catalogObject))
    else {
      check(false, "catalog: the vectors' catalog parses")
      finish()
    }
    check(
      catalog.drafts.allSatisfy { $0["state"] as? String != "waiting_network" },
      "catalog: no stored waiting_network")

    for v in list(vectors["listDrafts"]) { checkList(v, catalog) }
    for v in list(vectors["countDrafts"]) { checkCount(v, catalog) }
    for v in list(vectors["shownState"]) { checkShown(v) }
    for v in list(vectors["readCatalog"]) { checkRead(v) }
    checkFacade(catalog)
    finish()
  }

  static func finish() -> Never {
    print("\n\(passed) passed, \(failed) failed")
    exit(failed == 0 && passed > 0 ? 0 : 1)
  }

  static func list(_ v: Any?) -> [[String: Any]] { (v as? [Any])?.compactMap { $0 as? [String: Any] } ?? [] }

  static func net(_ v: Any?) -> PulseNetworkView {
    let o = v as? [String: Any] ?? [:]
    return PulseNetworkView(
      online: o["online"] as? Bool ?? true, wifi: o["wifi"] as? Bool ?? true,
      wifiOnlyUploads: o["wifiOnlyUploads"] as? Bool ?? false)
  }

  static func pairs(_ rows: [PulseCatalog.Row]) -> [[String]] {
    rows.map { [$0["id"] as? String ?? "?", $0["state"] as? String ?? "?"] }
  }

  static func counts(_ groups: [(key: String, count: Int)]) -> [String: Int] {
    Dictionary(groups.map { ($0.key, $0.count) }, uniquingKeysWith: +)
  }

  static func checkList(_ v: [String: Any], _ catalog: PulseCatalog.Catalog) {
    let name = "listDrafts: " + (v["name"] as? String ?? "?")
    guard case .success(let filter) = PulseCatalog.Filter.from(v["filter"] as? [String: Any] ?? [:])
    else { return check(false, name, "the filter didn't parse") }
    let expect = (v["expect"] as? [[String]]) ?? []
    let got = pairs(PulseCatalog.listDrafts(catalog, filter, net(v["net"])))
    check(got == expect, name, "got \(got)")
  }

  static func checkCount(_ v: [String: Any], _ catalog: PulseCatalog.Catalog) {
    let name = "countDrafts: " + (v["name"] as? String ?? "?")
    guard
      case .success(let options) = PulseCatalog.CountOptions.from(
        v["options"] as? [String: Any] ?? [:])
    else { return check(false, name, "the options didn't parse") }
    let expect = (v["expect"] as? [String: NSNumber])?.mapValues(\.intValue) ?? [:]
    let got = counts(PulseCatalog.countDrafts(catalog, options, net(v["net"])))
    check(got == expect, name, "got \(got)")
  }

  static func checkShown(_ v: [String: Any]) {
    let name = "shownState: " + (v["name"] as? String ?? "?")
    let got = PulseCatalog.shownState(v["state"] as? String, net(v["net"]))
    check(got == v["expect"] as? String, name, "got \(got ?? "nil")")
  }

  static func checkRead(_ v: [String: Any]) {
    let name = "readCatalog: " + (v["name"] as? String ?? "?")
    let reads = v["reads"] as? [String: [Any]] ?? [:]
    var seen: [String: Int] = [:]
    let found = PulseCatalog.read { file in
      let answers = reads[file] ?? [NSNull()]
      let i = min(seen[file, default: 0], answers.count - 1)
      seen[file] = i + 1
      return (answers[i] as? String).map { Data($0.utf8) }
    }
    let expect = (v["expect"] as? NSNumber)?.doubleValue
    check(found?.writtenAt == expect, name, "got \(found?.writtenAt.map { "\($0)" } ?? "nil")")
  }

  // MARK: - The facade's own rules, on the shared catalog

  static func checkFacade(_ catalog: PulseCatalog.Catalog) {
    let on = PulseNetworkView(online: true, wifi: true, wifiOnlyUploads: false)
    let off = PulseNetworkView(online: false, wifi: false, wifiOnlyUploads: false)

    let queued = PulseCatalog.getDraft(catalog, id: "d-queued", off)
    check(
      queued?["state"] as? String == "waiting_network"
        && (queued?["upload"] as? [String: Any])?["clientKey"] as? String
          == "inst-1:d-queued:0123456789abcdef",
      "facade: getDraft shows a queued draft offline as waiting_network, its fields passed through")
    check(
      PulseCatalog.getDraft(catalog, id: "r-kept", on)?["state"] as? String == "sent",
      "facade: getDraft finds a receipt")
    check(PulseCatalog.getDraft(catalog, id: "nope", on) == nil, "facade: getDraft of an unknown id is nil")

    let expected = PulseCatalog.Counts(drafts: 7, unsent: 7, uploading: 2, failed: 1, receipts: 3)
    check(PulseCatalog.counts(catalog, on) == expected, "facade: usage counts online", "\(PulseCatalog.counts(catalog, on))")
    check(
      PulseCatalog.counts(catalog, off) == expected,
      "facade: usage counts offline (waiting_network still counts as uploading)",
      "\(PulseCatalog.counts(catalog, off))")
    check(PulseCatalog.counts(.empty, on) == PulseCatalog.Counts(), "facade: no catalog counts nothing")

    check(PulseCatalog.parse(nil) == nil, "facade: no file is no catalog")
    check(PulseCatalog.parse(Data("[1,2]".utf8)) == nil, "facade: a JSON array is no catalog")
    check(
      PulseCatalog.parse(
        Data(#"{"format":"pulse-catalog","version":true,"drafts":[],"receipts":[]}"#.utf8)) == nil,
      "facade: a boolean version is no catalog")
    check(
      PulseCatalog.parse(
        Data(#"{"format":"pulse-catalog","version":1,"readOnly":true,"drafts":[],"receipts":[]}"#.utf8))?
        .readOnly == true,
      "facade: readOnly passes through")

    switch PulseCatalog.Filter.from(["contextKey": 5]) {
    case .failure: check(true, "facade: a non-string contextKey is invalid")
    case .success: check(false, "facade: a non-string contextKey is invalid")
    }
    switch PulseCatalog.Filter.from(["states": ["queued", 1]]) {
    case .failure: check(true, "facade: a non-string state is invalid")
    case .success: check(false, "facade: a non-string state is invalid")
    }
    if case .success(let f) = PulseCatalog.Filter.from(["contextKey": NSNull(), "extra": 1]) {
      check(f.contextKey == nil, "facade: a null field is a missing one; unknown fields are ignored")
    } else {
      check(false, "facade: a null field is a missing one; unknown fields are ignored")
    }
    switch PulseCatalog.CountOptions.from(["by": "contextKey", "attentionOnly": 1]) {
    case .failure: check(true, "facade: attentionOnly must be a boolean")
    case .success: check(false, "facade: attentionOnly must be a boolean")
    }
    switch PulseCatalog.CountOptions.from(["by": "place"]) {
    case .failure: check(true, "facade: by must be contextKey or contextKind")
    case .success: check(false, "facade: by must be contextKey or contextKind")
    }

    // JavaScript compares UTF-16 code units: a decomposed "é" is not a precomposed one.
    let composed = "ticket:caf\u{E9}"
    let decomposed = "ticket:cafe\u{301}"
    func row(_ id: String, _ key: String, _ at: Int) -> PulseCatalog.Row {
      ["id": id, "state": "draft", "updatedAt": at, "context": ["key": key, "kind": "ticket"]]
    }
    let unicode = PulseCatalog.Catalog(
      raw: [:], drafts: [row("a", composed, 2), row("b", decomposed, 1)], receipts: [])
    check(
      pairs(PulseCatalog.listDrafts(unicode, .init(contextKey: composed), on)) == [["a", "draft"]],
      "facade: contextKey compares UTF-16 code units")
    check(
      pairs(PulseCatalog.listDrafts(unicode, .init(contextKeyPrefix: "ticket:cafe"), on))
        == [["b", "draft"]],
      "facade: contextKeyPrefix compares UTF-16 code units")
    check(
      PulseCatalog.countDrafts(unicode, .init(by: .contextKey), on).count == 2,
      "facade: countDrafts keeps canonically equivalent keys apart")
    let ties = PulseCatalog.Catalog(
      raw: [:], drafts: [row("b", "k", 5), row("B", "k", 5), row("a", "k", 5)], receipts: [])
    check(
      pairs(PulseCatalog.listDrafts(ties, .init(), on)).map { $0[0] } == ["B", "a", "b"],
      "facade: equal times sort by id code unit ('B' < 'a')")
  }
}
