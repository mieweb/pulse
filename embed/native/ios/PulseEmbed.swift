import AVFoundation
import Foundation
import UIKit

/// Pulse inside another app. The host (or its Capacitor or Cordova plugin) calls only this class:
/// it presents Pulse full screen for one request and hands back that request's one result.
///
/// - Storage: everything Pulse keeps lives under the host-chosen `namespace`, in
///   `Library/PulseKit/<namespace>` (the library) and `Library/Caches/PulseKit/<namespace>`, never
///   in the host's Documents folder. Not under Application Support: expo-sqlite percent-encodes
///   the space in that name and would put the database in a different folder from the media.
/// - Results: Pulse writes `results/<requestId>.json` before it says it's done, so a result the
///   host never received (a crash, a kill) is still on disk; `pendingResults` returns those.
///   `acknowledge` deletes a result and its files once the host has what it needs.
/// - One request at a time: the camera and the audio session belong to the whole process.
@objc(PulseKitEmbed)
public final class PulseEmbed: NSObject {
  @objc public static let shared = PulseEmbed()

  /// A result as JSON-compatible values: `status` is "completed", "canceled" or "failed".
  public typealias Completion = ([String: Any]) -> Void

  private struct Request {
    let requestId: String
    let namespace: String
    let completion: Completion
    let audio: (category: AVAudioSession.Category, mode: AVAudioSession.Mode,
                options: AVAudioSession.CategoryOptions)
  }

  private var request: Request?
  private weak var presented: UIViewController?
  private var listening = false

  private override init() { super.init() }

  /// Present Pulse for `entry` ("full" or "record"). `completion` runs once, on the main thread.
  @objc public func present(
    from host: UIViewController,
    namespace: String,
    entry: String,
    completion: @escaping Completion
  ) {
    let requestId = UUID().uuidString.lowercased()
    func fail(_ code: String, _ message: String) {
      completion(["status": "failed", "requestId": requestId,
                  "error": ["code": code, "message": message]])
    }
    guard request == nil, host.presentedViewController == nil else {
      return fail("busy", "Pulse is already open, or the app is showing another screen.")
    }
    let roots: (documents: URL, caches: URL)
    do {
      roots = try Self.roots(namespace: namespace)
    } catch {
      return fail("invalid_options", error.localizedDescription)
    }
    let session = AVAudioSession.sharedInstance()
    request = Request(
      requestId: requestId, namespace: namespace, completion: completion,
      audio: (session.category, session.mode, session.categoryOptions))
    listen()

    ReactNativeHostManager.shared.initialize()
    let controller = ReactNativeViewController(
      moduleName: "main",
      initialProps: [
        "requestId": requestId,
        "entry": entry,
        "documentsDir": roots.documents.path,
        "cachesDir": roots.caches.path,
      ])
    controller.modalPresentationStyle = .fullScreen
    controller.isModalInPresentation = true
    presented = controller
    host.present(controller, animated: true)
  }

  /// Results Pulse finished but the host hasn't acknowledged, oldest first.
  @objc public func pendingResults(namespace: String) -> [[String: Any]] {
    guard let dir = try? Self.roots(namespace: namespace).documents
      .appendingPathComponent("results", isDirectory: true),
      let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path)
    else { return [] }
    return names
      .filter { $0.hasSuffix(".json") && !$0.hasSuffix(".project.json") }
      .compactMap { name -> (Date, [String: Any])? in
        let url = dir.appendingPathComponent(name)
        guard let result = Self.readJSON(url) else { return nil }
        let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
          .contentModificationDate ?? .distantPast
        return (date, result)
      }
      .sorted { $0.0 < $1.0 }
      .map { $0.1 }
  }

  /// Delete a result and its files (the video, the project document) once the host has them.
  @objc public func acknowledge(namespace: String, requestId: String) {
    guard Self.isPlainName(requestId),
      let dir = try? Self.roots(namespace: namespace).documents
        .appendingPathComponent("results", isDirectory: true)
    else { return }
    for suffix in [".json", ".mp4", ".project.json"] {
      try? FileManager.default.removeItem(at: dir.appendingPathComponent(requestId + suffix))
    }
  }

  // MARK: - Private

  private func listen() {
    guard !listening else { return }
    listening = true
    BrownfieldMessaging.addListener { [weak self] message in
      let type = message["type"] as? String
      let requestId = message["requestId"] as? String
      let text = message["message"] as? String
      DispatchQueue.main.async { self?.onMessage(type: type, requestId: requestId, message: text) }
    }
  }

  private func onMessage(type: String?, requestId: String?, message: String?) {
    guard let request, request.requestId == requestId else { return }
    var result: [String: Any]
    switch type {
    case "pulse.result":
      let file = (try? Self.roots(namespace: request.namespace).documents)?
        .appendingPathComponent("results/\(request.requestId).json")
      result = file.flatMap(Self.readJSON) ?? [
        "status": "failed", "requestId": request.requestId,
        "error": ["code": "unknown", "message": "Pulse finished but its result is missing."],
      ]
    case "pulse.error":
      result = [
        "status": "failed", "requestId": request.requestId,
        "error": ["code": "open_failed", "message": message ?? "Pulse couldn't open."],
      ]
    default:
      return
    }
    finish(result)
  }

  private func finish(_ result: [String: Any]) {
    guard let request else { return }
    self.request = nil
    let done = {
      let session = AVAudioSession.sharedInstance()
      try? session.setCategory(request.audio.category, mode: request.audio.mode,
                               options: request.audio.options)
      request.completion(result)
    }
    // Dismiss from the host's side: Pulse may have presented screens of its own (the editor, export)
    // on top of its controller, and dismissing the controller itself would only close the topmost.
    if let presenter = presented?.presentingViewController {
      presenter.dismiss(animated: true, completion: done)
    } else {
      done()
    }
    presented = nil
  }

  private static func roots(namespace: String) throws -> (documents: URL, caches: URL) {
    guard isPlainName(namespace) else {
      throw NSError(domain: "PulseKit", code: 1, userInfo: [
        NSLocalizedDescriptionKey:
          "The namespace must be 1–64 letters, digits, dots, dashes or underscores.",
      ])
    }
    let fm = FileManager.default
    let library = try fm.url(for: .libraryDirectory, in: .userDomainMask,
                             appropriateFor: nil, create: true)
    let caches = try fm.url(for: .cachesDirectory, in: .userDomainMask,
                            appropriateFor: nil, create: true)
    let documents = library.appendingPathComponent("PulseKit/\(namespace)", isDirectory: true)
    let cache = caches.appendingPathComponent("PulseKit/\(namespace)", isDirectory: true)
    for dir in [documents, cache] {
      try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    return (documents, cache)
  }

  private static func isPlainName(_ s: String) -> Bool {
    !s.isEmpty && s.count <= 64 && s != "." && s != ".."
      && s.unicodeScalars.allSatisfy {
        CharacterSet.alphanumerics.contains($0) && $0.isASCII || "._-".unicodeScalars.contains($0)
      }
  }

  private static func readJSON(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
  }
}
