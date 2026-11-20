// Mirrors embed/native/ios/PulseKitPresenter.swift (`PulseKitContainerViewController` and
// `PulseKitPreparingViewController`): the screen Pulse's flows and the brief "Preparing…" live in.
// On Android that is an Activity of its own over the host's (PR4-SPEC "Android differences":
// presentation), which also brings Android's own cases: back, process death, a task cleared under
// it, configuration changes.
package com.mieweb.pulse.kit

import android.app.Activity
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.ReactHost
import expo.modules.ReactActivityDelegateWrapper
import java.io.File
import org.json.JSONObject

/**
 * Pulse's full-screen Activity (AD27, AD22, G1): one React Native root per flow, or the brief
 * "Preparing…" root a host write boots the runtime under, started by [PulseKitPresenter].
 *
 * **Base class.** A `ReactActivity` with Expo's `ReactActivityDelegateWrapper` around a delegate
 * whose React host is expo-brownfield's `ReactNativeHostManager`: Spike S1's Activity, which
 * prompted, recorded and returned results on the S24. It gives every lifecycle call React Native
 * and Expo modules listen for (resume, pause, destroy, results, new intents, focus, configuration,
 * keys), and it is a `PermissionAwareActivity`, without which VisionCamera's permission request
 * throws and Expo's permission requests answer "denied" at once. expo-brownfield's
 * `BrownfieldActivity` with `ReactNativeViewFactory.createFrameLayout` forwards only resume, pause
 * and destroy and is not permission-aware, so it can't open the recorder.
 *
 * **Window.** Theme.PulseKit (black, no window animations), edge to edge (safe-area-context hands
 * Pulse JS the insets), portrait and `configChanges` from the library manifest, and no transition
 * on open or close: an instant cut, as on iOS. The status bar follows `pulse.ui` (light content on
 * black until Pulse JS says otherwise). Pulse's window is its own, so the host's status bar is
 * untouched and looks the same after Pulse closes.
 *
 * **Back.** Pulse JS owns it at every level (flow-stack.tsx: the model sheet, then one screen down,
 * then X with its sheet). Back that JS doesn't take, and back before JS is up, does nothing, so it
 * never leaves Pulse without the X sheet.
 *
 * **Ending.** Exactly one of these per screen:
 * - The facade dismisses it ([finishDismissed]): the Activity result is RESULT_OK with the `open`
 *   reply under [RESULT_EXTRA_JSON], and nothing is reported.
 * - Android finishes it without the facade (the host's singleTask Activity relaunched by a deep
 *   link or a push tap clears the task above it; the task is removed): `onViewGone(id,
 *   "interrupted")`. The take Pulse JS already saved stays a draft.
 * - Android destroys it without finishing it (Don't keep activities): `onViewGone(id, "system")`.
 * - A configuration change recreates it (one `configChanges` doesn't cover): nothing is reported;
 *   the next instance mounts a fresh root for the same flow.
 * - Android recreates it in a process that never launched it (process death, a restored task):
 *   `onRecreatedWithoutFlow(id, request)`, then it finishes with the result the facade wrote, and
 *   mounts nothing.
 * - Android recreates it after it already ended in this process: it finishes with that result.
 *
 * A new intent never ends it: deep links and push taps go to the host, which queues them until
 * Pulse closes. If the host's own launch mode clears this Activity anyway, the flow ends
 * `interrupted` as above.
 */
class PulseActivity : ReactActivity() {
  companion object {
    /** The flow's requestId (the "Preparing…" screen's own id in "preparing" mode). */
    const val EXTRA_REQUEST_ID = "com.mieweb.pulse.kit.requestId"

    /** [MODE_FLOW] or [MODE_PREPARING]. */
    const val EXTRA_MODE = "com.mieweb.pulse.kit.mode"

    /** The `open` request envelope (JSON), so a restored Activity can report the flow it lost. */
    const val EXTRA_REQUEST = "com.mieweb.pulse.kit.request"

    /** The React root's initial props (a Bundle, native-bridge §8.1). */
    const val EXTRA_PROPS = "com.mieweb.pulse.kit.props"

    /** In the Activity result: the `open` reply envelope (JSON), when the facade ended the flow. */
    const val RESULT_EXTRA_JSON = "json"

    /** [EXTRA_MODE] for a flow. */
    const val MODE_FLOW = "flow"

    /** [EXTRA_MODE] for the "Preparing…" screen. */
    const val MODE_PREPARING = "preparing"

    /** Which launch in this process the intent belongs to (PulseKitPresenter's token). */
    internal const val EXTRA_LAUNCH = "com.mieweb.pulse.kit.launch"

    private const val TAG = "PulseKit"
    private const val MAIN_COMPONENT = "main"
    private const val PREPARING_TEXT = 0xFFEBEBF5.toInt()
  }

  private var requestId = ""
  private var mode = MODE_FLOW
  private var token = -1L

  /** This instance mounted a React root (read by the delegate during super.onCreate). */
  private var mounted = false

  /** It ended through the facade or by itself: onDestroy reports nothing. */
  private var ended = false

  /** "Preparing…" drawn natively until the React root has content. */
  private var placeholder: View? = null

  private val backCallback =
    object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() = back()
    }

  override fun createReactActivityDelegate(): ReactActivityDelegate {
    // Called from ReactActivity's constructor: nothing here may read this Activity's fields yet.
    val inner =
      object : ReactActivityDelegate(this, MAIN_COMPONENT) {
        override fun getMainComponentName(): String? = if (mounted) MAIN_COMPONENT else null

        override fun getReactHost(): ReactHost? = ReactNativeHostManager.shared.getReactHost()

        override fun getLaunchOptions(): Bundle? =
          if (mounted) intent.getBundleExtra(EXTRA_PROPS) else null
      }
    return ReactActivityDelegateWrapper(this, inner)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    requestId = intent.getStringExtra(EXTRA_REQUEST_ID).orEmpty()
    mode = if (intent.getStringExtra(EXTRA_MODE) == MODE_PREPARING) MODE_PREPARING else MODE_FLOW
    token = intent.getLongExtra(EXTRA_LAUNCH, -1L)
    PulseKitPresenter.track(application)
    // "Preparing…" may have no id of its own (iOS uses ""); a flow always has one.
    val attach =
      if (requestId.isEmpty() && mode == MODE_FLOW) {
        PulseKitPresenter.Attach.UNKNOWN
      } else {
        PulseKitPresenter.attach(this, requestId, token)
      }
    var startFailure: RuntimeException? = null
    if (attach == PulseKitPresenter.Attach.MOUNT) {
      try {
        ReactNativeHostManager.shared.initialize(application)
        mounted = true
      } catch (e: RuntimeException) {
        startFailure = e
      }
    }
    val hostNightMode = AppCompatDelegate.getDefaultNightMode()
    // null, as Expo's MainActivity does: react-native-screens' fragments must never be restored.
    // The real savedInstanceState only tells a restored Activity apart (below).
    super.onCreate(null)
    keepHostNightMode(hostNightMode)
    setUpWindow()
    onBackPressedDispatcher.addCallback(this, backCallback)

    when (attach) {
      PulseKitPresenter.Attach.MOUNT -> {
        if (startFailure != null) return failToStart(startFailure)
        if (mode == MODE_FLOW) {
          PulseKitAudio.gain(this, requestId)
          PulseKit.shared(this).flows.onShown(requestId)
        }
        Log.i(TAG, "open $requestId: shown ($mode)")
      }
      PulseKitPresenter.Attach.DISMISSED,
      PulseKitPresenter.Attach.ENDED -> {
        Log.i(TAG, "open $requestId: already ended; closing without mounting")
        finishQuietly()
      }
      PulseKitPresenter.Attach.UNKNOWN -> {
        val restored = if (savedInstanceState != null) "restored" else "started"
        Log.i(TAG, "open $requestId: $restored with no flow in this process; closing")
        if (mode == MODE_FLOW && requestId.isNotEmpty()) {
          // The facade writes the fallback result here, before this Activity reads it below.
          PulseKit.shared(this)
            .flows
            .onRecreatedWithoutFlow(requestId, intent.getStringExtra(EXTRA_REQUEST))
        }
        finishQuietly()
      }
    }
  }

  override fun onDestroy() {
    val outcome = PulseKitPresenter.detach(this, requestId, token, isChangingConfigurations)
    when (outcome) {
      PulseKitPresenter.Detach.NOT_OWNER -> Unit
      PulseKitPresenter.Detach.DISMISSED -> PulseKitAudio.release(this, requestId)
      PulseKitPresenter.Detach.CONFIG_CHANGE ->
        Log.w(TAG, "open $requestId: recreated for a configuration change configChanges missed")
      PulseKitPresenter.Detach.GONE -> {
        PulseKitAudio.release(this, requestId)
        if (!ended) {
          val reason = if (isFinishing) "interrupted" else "system"
          Log.i(TAG, "open $requestId: the screen went away ($reason)")
          if (mode == MODE_FLOW) PulseKit.shared(this).flows.onViewGone(requestId, reason)
        }
      }
    }
    super.onDestroy()
  }

  // region Back

  /** React Native's fallback when Pulse JS took no back press: Pulse never leaves on back. */
  override fun invokeDefaultOnBackPressed() {
    Log.i(TAG, "open $requestId: back with no handler in Pulse JS; ignored")
  }

  @Suppress("OVERRIDE_DEPRECATION")
  override fun onBackPressed() = back()

  /**
   * Back goes to Pulse JS, and only there: ReactActivity's own fallback would finish the Activity
   * when React Native isn't up yet.
   */
  private fun back() {
    if (!reactActivityDelegate.onBackPressed()) {
      Log.i(TAG, "open $requestId: back before Pulse JS could take it; ignored")
    }
  }

  // endregion

  override fun onNewIntent(newIntent: Intent) {
    val id = newIntent.getStringExtra(EXTRA_REQUEST_ID)
    if (id != null && id != requestId) {
      Log.w(TAG, "open $requestId: ignored a new intent for $id")
      return
    }
    super.onNewIntent(newIntent)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // What BrownfieldActivity does: Expo modules hear about it too.
    BrownfieldLifecycleDispatcher.onConfigurationChanged(application, newConfig)
    // "auto" follows uiMode, which configChanges delivers here.
    applySystemBars()
  }

  /** Wraps the React root over the native "Preparing…" in that mode. */
  override fun setContentView(view: View?) {
    if (view == null || mode != MODE_PREPARING || placeholder != null) {
      return super.setContentView(view)
    }
    val frame = FrameLayout(this)
    val words = preparingView()
    val match = ViewGroup.LayoutParams.MATCH_PARENT
    frame.addView(words, FrameLayout.LayoutParams(match, match))
    (view.parent as? ViewGroup)?.removeView(view)
    frame.addView(view, FrameLayout.LayoutParams(match, match))
    placeholder = words
    super.setContentView(frame)
    removePlaceholderOnceDrawn(view)
  }

  // region For PulseKitPresenter

  /** The facade's dismiss: set the result from the inbox and finish, with no transition. */
  internal fun finishDismissed() {
    if (isFinishing) return
    Log.i(TAG, "open $requestId: dismissed")
    finishQuietly()
  }

  /** Applies the status bar `pulse.ui` asked for ("Preparing…" keeps light content, shown). */
  internal fun applySystemBars() {
    val (style, hidden) =
      if (mode == MODE_PREPARING) "light" to false else PulseKitPresenter.statusBar()
    val night =
      (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
        Configuration.UI_MODE_NIGHT_YES
    // "dark" content means a light background behind the bars; "auto" follows the system.
    val lightBackground =
      when (style) {
        "dark" -> true
        "light" -> false
        else -> !night
      }
    val controller = WindowCompat.getInsetsController(window, window.decorView)
    controller.isAppearanceLightStatusBars = lightBackground
    controller.isAppearanceLightNavigationBars = lightBackground
    if (hidden) {
      controller.systemBarsBehavior =
        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      controller.hide(WindowInsetsCompat.Type.statusBars())
    } else {
      controller.show(WindowInsetsCompat.Type.statusBars())
    }
  }

  // endregion

  private fun setUpWindow() {
    WindowCompat.setDecorFitsSystemWindows(window, false)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      // Under the cutout too: the recorder fills the screen and the insets say where it is.
      window.attributes =
        window.attributes.apply {
          layoutInDisplayCutoutMode =
            WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      overrideActivityTransition(Activity.OVERRIDE_TRANSITION_OPEN, 0, 0)
      overrideActivityTransition(Activity.OVERRIDE_TRANSITION_CLOSE, 0, 0)
    } else {
      @Suppress("DEPRECATION") overridePendingTransition(0, 0)
    }
    applySystemBars()
  }

  /**
   * Expo's system-UI listener (run by the delegate wrapper) sets AppCompat's process-wide night
   * mode from Pulse's own config. A host that chose one keeps it.
   */
  private fun keepHostNightMode(host: Int) {
    if (host == AppCompatDelegate.MODE_NIGHT_UNSPECIFIED) return
    if (AppCompatDelegate.getDefaultNightMode() == host) return
    Log.i(TAG, "open $requestId: kept the app's night mode ($host)")
    AppCompatDelegate.setDefaultNightMode(host)
  }

  /** React Native couldn't start: the facade ends the flow `failed{runtime.error}`. */
  private fun failToStart(e: RuntimeException) {
    Log.e(TAG, "open $requestId: Pulse couldn't start", e)
    ended = true
    PulseKit.shared(this).flows.onFatal(e)
    if (!isFinishing) finishQuietly()
  }

  /** Sets the Activity result from the inbox, finishes, and cuts with no transition. */
  private fun finishQuietly() {
    ended = true
    if (mode == MODE_FLOW) {
      val reply = inboxReply()
      if (reply != null) {
        setResult(Activity.RESULT_OK, Intent().putExtra(RESULT_EXTRA_JSON, reply))
      } else {
        setResult(Activity.RESULT_CANCELED)
      }
    }
    finish()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      @Suppress("DEPRECATION") overridePendingTransition(0, 0)
    }
  }

  /**
   * The `open` reply the facade gives for this flow: its result is `results/<requestId>.json`
   * under the namespace's documents folder, which Pulse JS (or the facade's fallback) writes before
   * the facade dismisses (native-bridge §6.2). Null when there is no readable result.
   */
  private fun inboxReply(): String? {
    if (requestId.isEmpty() || requestId.contains('/') || requestId.startsWith(".")) return null
    val documents = intent.getBundleExtra(EXTRA_PROPS)?.getString("documentsDir") ?: return null
    val file = File(documents, "results/$requestId.json")
    return try {
      if (!file.isFile) return null
      val result = JSONObject(file.readText())
      val callId =
        intent.getStringExtra(EXTRA_REQUEST)?.let { JSONObject(it).optString("callId") }.orEmpty()
      JSONObject()
        .put("v", 1)
        .put("callId", callId)
        .put("ok", true)
        .put("result", result)
        .toString()
    } catch (e: Exception) {
      Log.w(TAG, "open $requestId: couldn't read its result for the Activity result", e)
      null
    }
  }

  /** The native "Preparing…": a spinner and the words, centred on black, as on iOS. */
  private fun preparingView(): View {
    val density = resources.displayMetrics.density
    val spinner =
      ProgressBar(this).apply {
        isIndeterminate = true
        indeterminateTintList = ColorStateList.valueOf(PREPARING_TEXT)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      }
    val label =
      TextView(this).apply {
        setText(R.string.pulsekit_preparing)
        setTextColor(PREPARING_TEXT)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
        gravity = Gravity.CENTER
      }
    return LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setBackgroundColor(Color.BLACK)
      addView(spinner)
      addView(
        label,
        LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
          )
          .apply { topMargin = (12 * density).toInt() },
      )
    }
  }

  /**
   * Drops the native "Preparing…" once React Native has put content in its root (preparing.tsx
   * draws the same words on the same black), so TalkBack doesn't find it twice. If the root isn't
   * a ViewGroup it stays under the root, hidden by the root's own black.
   */
  private fun removePlaceholderOnceDrawn(root: View) {
    val group = root as? ViewGroup ?: return
    val observer = group.viewTreeObserver
    observer.addOnGlobalLayoutListener(
      object : ViewTreeObserver.OnGlobalLayoutListener {
        override fun onGlobalLayout() {
          if (group.childCount == 0) return
          placeholder?.let { (it.parent as? ViewGroup)?.removeView(it) }
          placeholder = null
          if (group.viewTreeObserver.isAlive) {
            group.viewTreeObserver.removeOnGlobalLayoutListener(this)
          }
        }
      }
    )
  }
}
