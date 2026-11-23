import Foundation

/// Where one namespace keeps its files (native-bridge.md §6), inside the host's sandbox:
/// `Library/PulseKit/<ns>` for the library and `Library/Caches/PulseKit/<ns>` for caches, never
/// the host's Documents folder. Not under Application Support: expo-sqlite percent-encodes the
/// space in that name and would put the database in a different folder from the media (M1).
struct PulseKitRoots {
  let namespace: String
  let documents: URL
  let caches: URL
  /// Captions models, shared by every namespace (§6.5).
  let models: URL

  /// Creates the folders when they are missing.
  init(namespace: String) throws {
    guard pulseIsPlainName(namespace) else {
      throw NSError(
        domain: "PulseKit", code: 1,
        userInfo: [
          NSLocalizedDescriptionKey:
            "The namespace must be 1–64 letters, digits, dots, dashes or underscores."
        ])
    }
    let fm = FileManager.default
    let library = try fm.url(
      for: .libraryDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let caches = try fm.url(
      for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    self.namespace = namespace
    documents = library.appendingPathComponent("PulseKit/\(namespace)", isDirectory: true)
    self.caches = caches.appendingPathComponent("PulseKit/\(namespace)", isDirectory: true)
    models = library.appendingPathComponent("PulseKit/.shared/models", isDirectory: true)
    for dir in [documents, self.caches, models] {
      try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    }
  }

  var inbox: PulseKitInbox { PulseKitInbox(dir: documents.appendingPathComponent("results")) }

  /// `logs/pulse.log`, which Pulse JS writes (§6.3).
  var logFile: URL { documents.appendingPathComponent("logs/pulse.log") }
}

/// The durable results inbox (§6.2, AD15). Pulse JS writes `results/<requestId>.json` before it
/// says a flow ended, so a lost message or a killed process loses nothing. The facade reads it,
/// and writes a result itself only when a flow ends without one (a fatal error, a forced close).
struct PulseKitInbox {
  let dir: URL

  /// Every unacknowledged result, oldest first. A file that can't be parsed is skipped.
  func pending() -> [JSONValue] {
    let fm = FileManager.default
    guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return [] }
    let entries = names.map { name -> PulseInboxEntry in
      let url = dir.appendingPathComponent(name)
      let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
        .contentModificationDate
      return PulseInboxEntry(name: name, modified: date?.timeIntervalSince1970 ?? 0)
    }
    return PulseInboxOrder.pending(entries).compactMap(read)
  }

  /// The result for `requestId`, or nil when there is none or it can't be parsed.
  func read(_ requestId: String) -> JSONValue? {
    guard pulseIsPlainName(requestId),
      let data = try? Data(contentsOf: dir.appendingPathComponent(requestId + ".json")),
      let value = try? JSONDecoder().decode(JSONValue.self, from: data),
      value.object != nil
    else { return nil }
    return value
  }

  /// Delete a result and its files. An unknown id is a no-op.
  func acknowledge(_ requestId: String) {
    guard pulseIsPlainName(requestId) else { return }
    for name in PulseInboxOrder.files(for: requestId) {
      try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
    }
  }

  /// Write `result` unless Pulse JS already wrote one: write a temp file, then move it into place,
  /// the same atomic pattern as Pulse JS. The temp name is the facade's own
  /// (`<id>.json.native-<uuid>.part`), never JS's `<id>.json.part`, so a forced close that races
  /// Pulse JS writing its real result can't delete or overwrite JS's temp file. The move fails if
  /// JS got there first, and JS's result wins; a result JS writes later replaces this one.
  func writeIfAbsent(_ result: JSONValue, requestId: String) {
    guard pulseIsPlainName(requestId) else { return }
    let fm = FileManager.default
    let dest = dir.appendingPathComponent(requestId + ".json")
    guard !fm.fileExists(atPath: dest.path) else { return }
    let part = dir.appendingPathComponent(
      "\(requestId).json.native-\(UUID().uuidString.lowercased()).part")
    do {
      try fm.createDirectory(at: dir, withIntermediateDirectories: true)
      try Data(result.serialized.utf8).write(to: part)
      if !fm.fileExists(atPath: dest.path) { try fm.moveItem(at: part, to: dest) }
    } catch {
      NSLog("[PulseKit] couldn't write the result for %@: %@", requestId, "\(error)")
    }
    try? fm.removeItem(at: part)
  }
}
