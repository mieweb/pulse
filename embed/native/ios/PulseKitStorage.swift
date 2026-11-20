import Foundation

/// Where every namespace lives on disk, and the rules for those folders (pulse-schema.md §6,
/// native-bridge.md §6.5, C4, C5):
///
/// ```
/// Library/PulseKit/<ns>/            documents root: SQLite, drafts, results, catalog.json, account.json, logs
/// Library/Caches/PulseKit/<ns>/     caches root
/// Library/PulseKit/.shared/models/  captions models, shared by every namespace
/// ```
///
/// - `Library/PulseKit` is excluded from backups: the library can hold patient-adjacent video, and
///   the models are large.
/// - Every folder and file under a namespace (and the shared models) is
///   NSFileProtectionCompleteUntilFirstUserAuthentication, whatever the host's own default: a host
///   with Complete protection would otherwise lock Pulse's files whenever the phone locks, and a
///   background upload couldn't read them. Files made later inherit their folder's class.
/// - The facade never opens SQLite: it deletes folders only after Pulse JS has let go of the
///   library (`releaseLibrary`, PulseKit.swift).
///
/// Foundation only; the protection class is iOS's (a no-op on a Mac).
enum PulseKitStorage {
  /// `Library/PulseKit`.
  static func libraryRoot() throws -> URL {
    try FileManager.default.url(
      for: .libraryDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("PulseKit", isDirectory: true)
  }

  /// `Library/Caches/PulseKit`.
  static func cachesRoot() throws -> URL {
    try FileManager.default.url(
      for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("PulseKit", isDirectory: true)
  }

  /// `Library/PulseKit/.shared`, which holds the captions models.
  static func sharedRoot() throws -> URL {
    try libraryRoot().appendingPathComponent(".shared", isDirectory: true)
  }

  /// The PR1-era namespace suffix: `<hostId>-local`, used before accounts existed.
  static let localSuffix = "-local"

  /// A namespace folder's name, never `.shared` or any other dot-name, and never a path.
  static func isNamespaceName(_ name: String) -> Bool {
    pulseIsPlainName(name) && !name.hasPrefix(".")
  }

  /// The roots of `namespace`, created when missing, with backup exclusion and file protection
  /// applied (once per namespace per process).
  static func roots(_ namespace: String) throws -> PulseKitRoots {
    guard isNamespaceName(namespace) else {
      throw NSError(
        domain: "PulseKit", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "\(namespace) isn't a namespace."])
    }
    let roots = try PulseKitRoots(namespace: namespace)
    prepare(roots)
    return roots
  }

  private static var prepared: Set<String> = []
  private static let lock = NSLock()

  /// Backup exclusion on `Library/PulseKit` (and the caches root, which iOS never backs up but a
  /// Mac might), and the protection class on the namespace's folders and the shared models.
  static func prepare(_ roots: PulseKitRoots) {
    lock.lock()
    let first = prepared.insert(roots.namespace).inserted
    lock.unlock()
    guard first else { return }
    for root in [try? libraryRoot(), try? cachesRoot()].compactMap({ $0 }) {
      excludeFromBackup(root)
    }
    for dir in [roots.documents, roots.caches, roots.models] { protect(tree: dir) }
  }

  /// Forget that a namespace was prepared (its folders were deleted).
  static func forget(_ namespace: String) {
    lock.lock()
    prepared.remove(namespace)
    lock.unlock()
  }

  static func excludeFromBackup(_ url: URL) {
    var url = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    do {
      try url.setResourceValues(values)
    } catch {
      NSLog("[PulseKit] couldn't exclude %@ from backups: %@", url.path, "\(error)")
    }
  }

  /// NSFileProtectionCompleteUntilFirstUserAuthentication on `dir` and everything under it. Items
  /// already in that class are left alone, so a second walk only reads.
  static func protect(tree dir: URL) {
    #if os(iOS)
      let fm = FileManager.default
      let wanted = FileProtectionType.completeUntilFirstUserAuthentication
      var paths = [dir.path]
      if let walk = fm.enumerator(atPath: dir.path) {
        for case let rel as String in walk { paths.append(dir.appendingPathComponent(rel).path) }
      }
      for path in paths {
        let current = (try? fm.attributesOfItem(atPath: path))?[.protectionKey] as? FileProtectionType
        guard current != wanted else { continue }
        do {
          try fm.setAttributes([.protectionKey: wanted], ofItemAtPath: path)
        } catch {
          NSLog("[PulseKit] couldn't set file protection on %@: %@", path, "\(error)")
        }
      }
    #endif
  }

  /// Write `data` atomically (a temp file, then a move over the old one) with the namespace's
  /// protection class.
  static func writeAtomically(_ data: Data, to url: URL) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    #if os(iOS)
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
      try data.write(to: url, options: [.atomic])
    #endif
  }

  // MARK: - Reading the folders

  /// Bytes on disk under `url` (allocated size where the file system reports it), 0 when missing.
  static func size(of url: URL) -> Int64 {
    let keys: [URLResourceKey] = [.isRegularFileKey, .totalFileAllocatedSizeKey, .fileSizeKey]
    guard
      let walk = FileManager.default.enumerator(
        at: url, includingPropertiesForKeys: keys, options: [], errorHandler: { _, _ in true })
    else { return 0 }
    var total: Int64 = 0
    for case let file as URL in walk {
      guard let v = try? file.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else {
        continue
      }
      total += Int64(v.totalFileAllocatedSize ?? v.fileSize ?? 0)
    }
    return total
  }

  /// Both roots of a namespace together, in bytes.
  static func bytes(of namespace: String) -> Int64 {
    guard isNamespaceName(namespace), let lib = try? libraryRoot(), let caches = try? cachesRoot()
    else { return 0 }
    return size(of: lib.appendingPathComponent(namespace)) + size(of: caches.appendingPathComponent(namespace))
  }

  /// The namespace folders under `Library/PulseKit`, by name; `.shared` and other dot-names are not
  /// namespaces.
  static func namespaceNames() -> [String] {
    guard let root = try? libraryRoot(),
      let names = try? FileManager.default.contentsOfDirectory(atPath: root.path)
    else { return [] }
    return names.filter { name in
      var isDir: ObjCBool = false
      return isNamespaceName(name)
        && FileManager.default.fileExists(
          atPath: root.appendingPathComponent(name).path, isDirectory: &isDir) && isDir.boolValue
    }.sorted()
  }

  /// Drafts with a folder under `drafts/`: what a namespace without a catalog (PR1's `-local`)
  /// still holds. Pulse keeps each draft's clips and covers in `drafts/<draftId>/`.
  static func draftFolders(in documents: URL) -> Int {
    let drafts = documents.appendingPathComponent("drafts", isDirectory: true)
    let names = (try? FileManager.default.contentsOfDirectory(atPath: drafts.path)) ?? []
    return names.filter { !$0.hasPrefix(".") }.count
  }

  /// Whether a namespace holds nothing a person made: no draft folders, no catalog rows, and no
  /// result waiting in the inbox. An empty library database alone doesn't count.
  static func isEmpty(documents: URL) -> Bool {
    if draftFolders(in: documents) > 0 { return false }
    if let catalog = PulseCatalog.read(in: documents),
      !catalog.drafts.isEmpty || !catalog.receipts.isEmpty
    {
      return false
    }
    let results = documents.appendingPathComponent("results", isDirectory: true)
    let pending = (try? FileManager.default.contentsOfDirectory(atPath: results.path)) ?? []
    return !pending.contains { $0.hasSuffix(".json") }
  }

  /// When the folder was last written, in ms since 1970 (0 when unknown).
  static func modifiedAt(_ url: URL) -> Int64 {
    let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
      .contentModificationDate
    return Int64((date?.timeIntervalSince1970 ?? 0) * 1000)
  }

  // MARK: - Deleting

  /// Delete both roots of `namespace`. The shared models go too when no namespace is left, and
  /// then the empty `PulseKit` folders themselves, so a purged phone holds nothing of Pulse's.
  static func remove(namespace: String) throws {
    guard isNamespaceName(namespace) else { return }
    let fm = FileManager.default
    let lib = try libraryRoot()
    let caches = try cachesRoot()
    for dir in [lib.appendingPathComponent(namespace), caches.appendingPathComponent(namespace)]
    where fm.fileExists(atPath: dir.path) {
      try fm.removeItem(at: dir)
    }
    forget(namespace)
    guard namespaceNames().isEmpty else { return }
    let shared = try sharedRoot()
    if fm.fileExists(atPath: shared.path) { try fm.removeItem(at: shared) }
    for root in [lib, caches] {
      if let left = try? fm.contentsOfDirectory(atPath: root.path), left.isEmpty {
        try? fm.removeItem(at: root)
      }
    }
  }
}
