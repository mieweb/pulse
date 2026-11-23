import AVFoundation
import UIKit

/// The view controller Pulse's screens live in while a flow is open (AD22, AD27).
///
/// It owns what would otherwise leak into the host: the status bar (it works under the host's
/// `UIViewControllerBasedStatusBarAppearance=YES`, which no host is asked to change), portrait
/// on iPhone even when the host allows landscape, and the theme bridge's appearance, set on this
/// controller only, never on the window or app-wide. Pulse JS steers it with `pulse.ui`
/// messages; until JS says otherwise it shows a dark skeleton with light status-bar text.
///
/// `pulse.ui` is a PR1 addition to native-bridge.md §8.1 (JS → native), written up in
/// vectors/README.md until the contract carries it.
final class PulseKitContainerViewController: UIViewController {
  private let content: UIViewController
  private let skeleton = UIView()
  private var statusBarStyle: UIStatusBarStyle = .lightContent
  private var statusBarHidden = false
  private var contentObserver: NSObjectProtocol?
  private var accent: UIColor?
  /// The last `hasTake` from Pulse JS: a take would be lost if the flow ended now.
  private(set) var hasTake = false

  /// Called when the host dismissed Pulse itself rather than through `close`.
  var onDismissedByHost: (() -> Void)?

  init(content: UIViewController, theme: JSONValue?) {
    self.content = content
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
    modalPresentationCapturesStatusBarAppearance = true
    // Swipe-to-dismiss stays off until Pulse says there is no take to lose (`pulse.ui`).
    isModalInPresentation = true
    apply(theme: theme)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit {
    if let contentObserver { NotificationCenter.default.removeObserver(contentObserver) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    view.accessibilityViewIsModal = true
    if let accent { view.tintColor = accent }

    // The dark skeleton: black with the recorder's shutter ring, so a cold start shows no white
    // flash. Pulse's first screen draws over it; it goes when React Native's content appears.
    skeleton.frame = view.bounds
    skeleton.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    skeleton.isAccessibilityElement = true
    skeleton.accessibilityLabel = "Loading"
    let ring = UIView()
    ring.translatesAutoresizingMaskIntoConstraints = false
    ring.layer.cornerRadius = 38
    ring.layer.borderWidth = 4
    ring.layer.borderColor = UIColor(white: 1, alpha: 0.35).cgColor
    skeleton.addSubview(ring)
    NSLayoutConstraint.activate([
      ring.widthAnchor.constraint(equalToConstant: 76),
      ring.heightAnchor.constraint(equalToConstant: 76),
      ring.centerXAnchor.constraint(equalTo: skeleton.centerXAnchor),
      ring.bottomAnchor.constraint(
        equalTo: skeleton.safeAreaLayoutGuide.bottomAnchor, constant: -32),
    ])
    view.addSubview(skeleton)

    addChild(content)
    content.view.frame = view.bounds
    content.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    // Transparent while React Native boots, so the skeleton shows instead of a white root view.
    content.view.backgroundColor = .clear
    view.addSubview(content.view)
    content.didMove(toParent: self)

    // React's RCTContentDidAppearNotification, by name, so this file needs no React import.
    contentObserver = NotificationCenter.default.addObserver(
      forName: Notification.Name("RCTContentDidAppearNotification"), object: nil, queue: .main
    ) { [weak self] note in
      guard let self, let root = note.object as? UIView, root.isDescendant(of: self.content.view)
      else { return }
      self.skeleton.removeFromSuperview()
    }
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isBeingDismissed { onDismissedByHost?() }
  }

  // MARK: Status bar and orientation

  override var preferredStatusBarStyle: UIStatusBarStyle { statusBarStyle }
  override var prefersStatusBarHidden: Bool { statusBarHidden }
  override var preferredStatusBarUpdateAnimation: UIStatusBarAnimation { .none }
  // This controller decides, not React Native's root controller inside it.
  override var childForStatusBarStyle: UIViewController? { nil }
  override var childForStatusBarHidden: UIViewController? { nil }

  override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
    traitCollection.userInterfaceIdiom == .phone || UIDevice.current.userInterfaceIdiom == .phone
      ? .portrait : .all
  }
  override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation { .portrait }

  // MARK: Messages from Pulse JS

  /// `pulse.ui` from Pulse JS: `{ type: 'pulse.ui', statusBar?: 'light'|'dark'|'auto',
  /// statusBarHidden?: bool, hasTake?: bool, sending?: bool }` (`sending` is PulseKit's: its
  /// close watchdog). Each field is optional and sticks until the next
  /// message sets it; unknown fields and values are ignored ('auto' and anything else → the
  /// system default for the appearance).
  func apply(ui: JSONValue) {
    if let style = ui["statusBar"]?.string {
      statusBarStyle =
        switch style {
        case "light": .lightContent
        case "dark": .darkContent
        default: .default
        }
    }
    if let hidden = ui["statusBarHidden"]?.bool { statusBarHidden = hidden }
    if let hasTake = ui["hasTake"]?.bool {
      self.hasTake = hasTake
      isModalInPresentation = hasTake
    }
    setNeedsStatusBarAppearanceUpdate()
  }

  /// ThemeBridge (F6, AD26), on this controller only: its appearance and accent. Pulse JS gets
  /// the same theme in its initial props and styles its own screens from it.
  func apply(theme: JSONValue?) {
    switch theme?["appearance"]?.string {
    case "light": overrideUserInterfaceStyle = .light
    case "dark": overrideUserInterfaceStyle = .dark
    default: overrideUserInterfaceStyle = .unspecified
    }
    accent = theme?["accent"]?.string.flatMap(Self.color(hex:))
    if isViewLoaded, let accent { view.tintColor = accent }
  }

  /// '#rrggbb' → UIColor; nil for anything else.
  static func color(hex: String) -> UIColor? {
    guard hex.count == 7, hex.hasPrefix("#"), let rgb = UInt32(hex.dropFirst(), radix: 16) else {
      return nil
    }
    return UIColor(
      red: CGFloat((rgb >> 16) & 0xff) / 255, green: CGFloat((rgb >> 8) & 0xff) / 255,
      blue: CGFloat(rgb & 0xff) / 255, alpha: 1)
  }
}

/// The brief "Preparing…" screen (AD5, O2): what a host write shows when Pulse's runtime is cold
/// and this build doesn't run it without a screen (no `headless`, PulseKitInfo.swift). It holds
/// the command runtime's React root (`request: null, headless: false`), which draws the same words
/// (embed/src/shell/preparing.tsx) once it boots; until then this controller shows them natively
/// on black, so nothing flashes. PulseKit dismisses it as soon as the writes it was presented for
/// are answered. Full screen, no swipe-to-dismiss, portrait on iPhone, light status bar.
final class PulseKitPreparingViewController: UIViewController {
  private let content: UIViewController
  private let placeholder = UIStackView()
  private var contentObserver: NSObjectProtocol?

  init(content: UIViewController) {
    self.content = content
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
    modalPresentationCapturesStatusBarAppearance = true
    isModalInPresentation = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit {
    if let contentObserver { NotificationCenter.default.removeObserver(contentObserver) }
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    view.accessibilityViewIsModal = true

    let spinner = UIActivityIndicatorView(style: .medium)
    spinner.color = UIColor(white: 0.92, alpha: 1)
    spinner.startAnimating()
    let label = UILabel()
    label.text = "Preparing…"
    label.textColor = UIColor(white: 0.92, alpha: 1)
    label.font = .preferredFont(forTextStyle: .body)
    label.adjustsFontForContentSizeCategory = true
    placeholder.axis = .vertical
    placeholder.alignment = .center
    placeholder.spacing = 12
    placeholder.addArrangedSubview(spinner)
    placeholder.addArrangedSubview(label)
    placeholder.isAccessibilityElement = true
    placeholder.accessibilityLabel = "Preparing"
    placeholder.accessibilityTraits = .updatesFrequently
    placeholder.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(placeholder)
    NSLayoutConstraint.activate([
      placeholder.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      placeholder.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])

    addChild(content)
    content.view.frame = view.bounds
    content.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    content.view.backgroundColor = .clear
    view.addSubview(content.view)
    content.didMove(toParent: self)

    contentObserver = NotificationCenter.default.addObserver(
      forName: Notification.Name("RCTContentDidAppearNotification"), object: nil, queue: .main
    ) { [weak self] note in
      guard let self, let root = note.object as? UIView, root.isDescendant(of: self.content.view)
      else { return }
      self.placeholder.removeFromSuperview()
    }
  }

  override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
  override var childForStatusBarStyle: UIViewController? { nil }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
    UIDevice.current.userInterfaceIdiom == .phone ? .portrait : .all
  }
}

/// Presenting and dismissing: an instant cut (Pulse adds no decorative motion), or a crossfade
/// when Reduce Motion is on, where a hard cut between very different screens is harsher.
enum PulseKitPresenter {
  /// Where a screen PulseKit shows on its own ("Preparing…") is presented from: the topmost
  /// controller above `presenter` (or the key window's root), skipping one on its way out. Nil
  /// when there's no window to present in.
  static func topmost(_ presenter: UIViewController?) -> UIViewController? {
    let start =
      presenter
      ?? UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)?.rootViewController
    guard var top = start else { return nil }
    while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
    return top.viewIfLoaded?.window == nil ? nil : top
  }

  static func present(_ container: UIViewController, from presenter: UIViewController) {
    let fade = UIAccessibility.isReduceMotionEnabled
    container.modalTransitionStyle = fade ? .crossDissolve : .coverVertical
    presenter.present(container, animated: fade)
  }

  /// Dismiss from the presenting side (M1 finding 4): Pulse may have presented screens of its own
  /// on top of the container, and dismissing the container itself would only close the topmost.
  /// VoiceOver then moves to the host's screen.
  ///
  /// `completion` runs exactly once. UIKit refuses a dismissal while the container is still being
  /// presented (a `pulse.error` or a fatal during the Reduce Motion crossfade) and then never calls
  /// back, so that case waits for the presentation to finish first; and if UIKit still hasn't
  /// called back after 3 s, the completion runs anyway, so every waiting `open` gets its reply.
  static func dismiss(_ container: UIViewController, completion: @escaping () -> Void) {
    let once = Once()
    let done = {
      guard !once.called else { return }
      once.called = true
      UIAccessibility.post(notification: .screenChanged, argument: nil)
      completion()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
      guard !once.called else { return }
      NSLog("[PulseKit] the dismissal didn't complete in 3 s; ending the flow anyway")
      done()
    }
    dismissWhenSettled(container, attemptsLeft: 20, done)
  }

  private final class Once { var called = false }

  private static func dismissWhenSettled(
    _ container: UIViewController, attemptsLeft: Int, _ done: @escaping () -> Void
  ) {
    if container.isBeingPresented, attemptsLeft > 0 {
      if let coordinator = container.transitionCoordinator {
        coordinator.animate(alongsideTransition: nil) { _ in
          DispatchQueue.main.async { dismissWhenSettled(container, attemptsLeft: 0, done) }
        }
      } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
          dismissWhenSettled(container, attemptsLeft: attemptsLeft - 1, done)
        }
      }
      return
    }
    guard !container.isBeingDismissed, let presenting = container.presentingViewController else {
      return done()
    }
    presenting.dismiss(animated: UIAccessibility.isReduceMotionEnabled, completion: done)
  }
}

/// The host's audio session, saved before Pulse opens and put back after it closes (M1, kept):
/// the recorder switches the process-wide session to play-and-record.
struct PulseKitAudioState {
  let category: AVAudioSession.Category
  let mode: AVAudioSession.Mode
  let options: AVAudioSession.CategoryOptions
  /// Another app (music, a podcast) was playing when Pulse opened.
  let otherAudioWasPlaying: Bool

  static func save() -> PulseKitAudioState {
    let s = AVAudioSession.sharedInstance()
    return PulseKitAudioState(
      category: s.category, mode: s.mode, options: s.categoryOptions,
      otherAudioWasPlaying: s.isOtherAudioPlaying)
  }

  /// Put the category back, and when other audio was playing, deactivate with
  /// `notifyOthersOnDeactivation` so that app resumes. The recorder's camera and mic may still be
  /// stopping when the dismissal completes (they stop once React unmounts on the JS thread), and
  /// then deactivating fails as busy: it is retried after 0.3, 0.6 and 1.0 s (about 1.9 s in all,
  /// inside the 2 s the device check allows), as long as `stillClosed()` says no new flow owns
  /// the session.
  func restore(while stillClosed: @escaping () -> Bool) {
    let s = AVAudioSession.sharedInstance()
    do {
      try s.setCategory(category, mode: mode, options: options)
    } catch {
      NSLog("[PulseKit] couldn't restore the audio category: %@", "\(error)")
    }
    if otherAudioWasPlaying { Self.deactivate(retryDelays: [0.3, 0.6, 1.0], stillClosed) }
  }

  private static func deactivate(
    retryDelays: ArraySlice<Double>, _ stillClosed: @escaping () -> Bool
  ) {
    guard stillClosed() else { return }
    do {
      try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    } catch {
      guard let delay = retryDelays.first else {
        NSLog(
          "[PulseKit] couldn't hand the audio session back (%@); giving up, other audio won't resume",
          "\(error)")
        return
      }
      NSLog(
        "[PulseKit] couldn't hand the audio session back (%@); retrying in %.1f s", "\(error)",
        delay)
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
        Self.deactivate(retryDelays: retryDelays.dropFirst(), stillClosed)
      }
    }
  }
}
