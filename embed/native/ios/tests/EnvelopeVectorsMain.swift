import Foundation

// Runs vectors/envelope.json against PulseKitEnvelope.swift, on a Mac, with no iOS build:
//
//   xcrun swiftc -o "$TMPDIR/pk-envelope-vectors" \
//     embed/native/ios/PulseKitEnvelope.swift embed/native/ios/tests/EnvelopeVectorsMain.swift
//   "$TMPDIR/pk-envelope-vectors" embed/native/ios/vectors/envelope.json
//
// Prints one line per vector and exits 1 if any fails. The JS client runs the same file in jest.

@main
struct EnvelopeVectors {
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
      let vectors = try? JSONDecoder().decode(JSONValue.self, from: data)
    else {
      print("usage: pk-envelope-vectors <path to envelope.json>")
      exit(2)
    }

    checkContract(vectors)
    for v in vectors["requests"]?.array ?? [] { checkRequest(v) }
    for v in vectors["replies"]?.array ?? [] { checkReply(v) }
    for v in vectors["open"]?.array ?? [] { checkOpen(v) }
    for v in vectors["busy"]?.array ?? [] { checkBusy(v) }
    for v in vectors["inbox"]?.array ?? [] { checkInbox(v) }
    for v in vectors["acknowledge"]?.array ?? [] { checkAcknowledge(v) }
    for v in vectors["namespace"]?.array ?? [] { checkNamespace(v) }
    for v in vectors["configure"]?.array ?? [] { checkConfigure(v) }

    print("\n\(passed) passed, \(failed) failed")
    exit(failed == 0 && passed > 0 ? 0 : 1)
  }

  static func strings(_ v: JSONValue?) -> [String] { v?.array?.compactMap(\.string) ?? [] }

  static func checkContract(_ vectors: JSONValue) {
    check(
      vectors["contract"]?["major"]?.integer == Int64(PulseContract.major)
        && vectors["contract"]?["minor"]?.integer == Int64(PulseContract.minor),
      "contract: the vectors' major/minor match the facade")
    check(
      strings(vectors["methods"]?["native"]) == PulseContract.nativeMethods,
      "contract: native method list", "\(PulseContract.nativeMethods)")
    check(
      strings(vectors["methods"]?["minor1"]) == PulseContract.minor1Methods,
      "contract: minor-1 method list", "\(PulseContract.minor1Methods)")
  }

  static func checkRequest(_ v: JSONValue) {
    let name = "request: " + (v["name"]?.string ?? "?")
    let text = v["requestText"]?.string ?? v["request"]?.serialized ?? ""
    let supported = v["supported"]?.bool ?? true
    let expect = v["expect"] ?? .null
    let route = PulseRouter.route(text, supported: supported)
    switch (route, expect["route"]?.string) {
    case (.native(let req), "native"):
      check(
        req.method == expect["method"]?.string && .object(req.args) == expect["args"],
        name, "got \(req.method) \(JSONValue.object(req.args).serialized)")
    case (.reply(let reply), "reply"):
      let replyJSON = JSONValue.parse(reply.serialized)
      let ok =
        reply.ok == false && reply.v == 1
        && reply.callId == expect["callId"]?.string
        && reply.error?.callId == expect["callId"]?.string
        && reply.error?.code == expect["error"]?["code"]?.string
        && reply.error?.recoverable == expect["error"]?["recoverable"]?.bool
        && !(reply.error?.message.isEmpty ?? true)
        && replyJSON?["result"] == nil
      check(ok, name, reply.serialized)
    default:
      check(false, name, "routed \(route)")
    }
  }

  static func checkReply(_ v: JSONValue) {
    let name = "reply: " + (v["name"]?.string ?? "?")
    if let build = v["build"] {
      let callId = build["callId"]?.string ?? ""
      let reply: PulseReply
      if build["ok"]?.bool == true {
        reply = .success(callId, build["result"] ?? .null)
      } else {
        let e = build["error"] ?? .null
        reply = .failure(
          e["code"]?.string ?? "", e["message"]?.string ?? "", callId: callId,
          requestId: e["requestId"]?.string)
      }
      check(reply.serialized == v["expectText"]?.string, name, reply.serialized)
    } else if let text = v["parse"]?.string {
      let decoded = try? JSONDecoder().decode(PulseReply.self, from: Data(text.utf8))
      let expect = v["expect"] ?? .null
      check(
        decoded?.ok == expect["ok"]?.bool && decoded?.callId == expect["callId"]?.string
          && decoded?.result == expect["result"],
        name, decoded?.serialized ?? "didn't decode")
    }
  }

  static func checkOpen(_ v: JSONValue) {
    let name = "open: " + (v["name"]?.string ?? "?")
    let expect = v["expect"] ?? .null
    switch PulseArgs.open(v["args"]?.object ?? [:], callId: "c-open") {
    case .success(let args):
      check(
        expect["ok"]?.bool == true && args.entry == expect["entry"]?.string
          && args.requestId == expect["requestId"]?.string,
        name, "accepted \(args.entry) \(args.requestId ?? "nil")")
    case .failure(let error):
      check(
        expect["ok"]?.bool == false && error.code == expect["code"]?.string
          && error.callId == "c-open",
        name, "refused \(error.code): \(error.message)")
    }
  }

  static func checkBusy(_ v: JSONValue) {
    let name = "busy: " + (v["name"]?.string ?? "?")
    guard let presenter = v["presenter"]?.string.flatMap(PulsePresenterState.init(rawValue:)) else {
      return check(false, name, "bad presenter")
    }
    let decision = PulseOpenGate.decide(
      openRequestId: v["open"]?.string, requestId: v["requestId"]?.string, presenter: presenter,
      pending: v["pending"]?.bool ?? false)
    check(decision.rawValue == v["expect"]?.string, name, decision.rawValue)
  }

  static func checkInbox(_ v: JSONValue) {
    let name = "inbox: " + (v["name"]?.string ?? "?")
    let entries = (v["files"]?.array ?? []).map {
      PulseInboxEntry(
        name: $0["name"]?.string ?? "", modified: Double($0["modified"]?.integer ?? 0))
    }
    let got = PulseInboxOrder.pending(entries)
    check(got == strings(v["expect"]), name, "\(got)")
  }

  static func checkAcknowledge(_ v: JSONValue) {
    let id = v["requestId"]?.string ?? ""
    let got = PulseInboxOrder.files(for: id)
    check(got == strings(v["expect"]), "acknowledge: deletes \(id)'s files", "\(got)")
  }

  static func checkNamespace(_ v: JSONValue) {
    let bundleId = v["bundleId"]?.string ?? ""
    let got = PulseNamespace.local(hostId: PulseNamespace.sanitise(bundleId))
    check(
      got == v["expect"]?.string && pulseIsPlainName(got), "namespace: \(bundleId)", got)
  }

  static func checkConfigure(_ v: JSONValue) {
    let args = v["args"]?.object ?? [:]
    let got = PulseArgs.configure(args, callId: "c-configure")?.code ?? "ok"
    check(got == v["expect"]?.string, "configure: \(JSONValue.object(args).serialized)", got)
  }
}
