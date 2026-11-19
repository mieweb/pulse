import Foundation

/// Background URLSession events (E5, H5). The host's AppDelegate forwards
/// `application(_:handleEventsForBackgroundURLSession:completionHandler:)` here, by selector
/// through `NSClassFromString("PulseKit")`, so it needs no compile-time dependency on PulseKit.
///
/// PR1 has no background uploads yet: a Pulse session's handler is stored and called at once.
/// PR2's upload session takes the stored handler instead and calls it when the session's events
/// are delivered (`urlSessionDidFinishEvents`).
extension PulseKit {
  /// Background sessions Pulse owns are named `com.mieweb.pulsekit.upload.<namespace>` (§4).
  static let backgroundSessionPrefix = "com.mieweb.pulsekit.upload."

  /// Returns true when the session is Pulse's: PulseKit then calls `completionHandler`. Returns
  /// false, without calling it, for any other session; the host handles those itself.
  ///
  /// Frozen Objective-C name: `handleEventsForBackgroundURLSession:completionHandler:`, with the
  /// C signature `BOOL (id self, SEL _cmd, NSString *identifier, void (^completionHandler)(void))`.
  @objc(handleEventsForBackgroundURLSession:completionHandler:)
  public func handleEventsForBackgroundURLSession(
    _ identifier: String, completionHandler: @escaping () -> Void
  ) -> Bool {
    guard identifier.hasPrefix(Self.backgroundSessionPrefix) else { return false }
    let store = {
      self.backgroundCompletions[identifier] = completionHandler
      self.log("background session events for \(identifier)")
      // Nothing in PR1 delivers them, so finish now; the system must always get its callback.
      self.completeBackgroundEvents(identifier)
    }
    if Thread.isMainThread { store() } else { DispatchQueue.main.async(execute: store) }
    return true
  }

  /// Call and forget the stored handler for `identifier` (main queue).
  func completeBackgroundEvents(_ identifier: String) {
    backgroundCompletions.removeValue(forKey: identifier)?()
  }
}
