// Mirrors embed/native/ios/PulseKitPresenter.swift (`PulseKitPresenter`, the container's
// `pulse.ui` handling and the "Preparing…" screen's presentation). On Android Pulse's screens live
// in their own Activity (PulseActivity.kt) rather than a view controller presented over the host's,
// so presenting is starting that Activity and dismissing is finishing it.
package com.mieweb.pulse.kit

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.mieweb.pulse.kit.core.PresenterState
import java.lang.ref.WeakReference

/**
 * PulseKit's presenter (PresenterPort, PR4-SPEC "Frozen names"): starts PulseActivity for a flow
 * or the "Preparing…" screen, finishes it when the facade says so, applies `pulse.ui` to it, and
 * answers where presentation stands for the busy gate (core.PulseBusy).
 *
 * It keeps one record per launched screen, keyed by requestId, so PulseActivity can tell a screen
 * this process launched from one Android restored on its own (process death, a restored task) and
 * the facade's `dismiss` can reach a screen that hasn't been created yet. Every Activity it knows
 * is held weakly and dropped in that Activity's onDestroy: nothing here keeps an Activity alive.
 *
 * Main thread only (PresenterPort's rule), so there is no locking.
 */
internal object PulseKitPresenter : PresenterPort {
  private const val TAG = "PulseKit"

  /** How many ended requestIds to remember (see [ended]). One flow runs at a time. */
  private const val ENDED_KEPT = 32

  /** A screen PulseKit launched in this process. */
  private class Live(val requestId: String, val mode: String, val token: Long) {
    /** The PulseActivity showing it, once created; cleared in its onDestroy. */
    var screen: WeakReference<PulseActivity>? = null

    /** The facade asked for it to close. */
    var dismissed = false
  }

  /** What PulseActivity.onCreate should do with the screen it was started for. */
  internal enum class Attach {
    /** Mount the React root: this process launched it and it is still wanted. */
    MOUNT,

    /** The facade dismissed it before it was created: finish with the result, mount nothing. */
    DISMISSED,

    /** It ended in this process already (reported then): finish with the result, mount nothing. */
    ENDED,

    /** This process never launched it (process death, a restored task): report and finish. */
    UNKNOWN,
  }

  /** What PulseActivity.onDestroy should report. */
  internal enum class Detach {
    /** The facade dismissed it: nothing to report. */
    DISMISSED,

    /** Recreated for a configuration change: the flow goes on in the next instance. */
    CONFIG_CHANGE,

    /** It went away without the facade: the flow ends (FlowPort.onViewGone). */
    GONE,

    /** This instance never owned a live screen (it finished in onCreate): nothing to report. */
    NOT_OWNER,
  }

  private val live = HashMap<String, Live>()

  /**
   * requestIds whose screen ended in this process. A screen Android recreates for one of them
   * (Don't keep activities, then back to the task) finishes without asking the facade to end the
   * flow a second time.
   */
  private val ended = LinkedHashSet<String>()

  private val main = Handler(Looper.getMainLooper())

  private var appContext: Context? = null
  private var tracking = false

  /** The last Activity of the app that resumed, until it pauses. */
  private var resumed: WeakReference<Activity>? = null

  /** The last Activity of the app that resumed, until it stops: the foreground Activity. */
  private var foreground: WeakReference<Activity>? = null

  // `pulse.ui` for the showing flow (native-bridge §8.1): each field sticks until set again, and a
  // new flow starts from the container's defaults (light status-bar content, shown, no take).
  private var statusBar = "light"
  private var statusBarHidden = false

  /** The last `hasTake` Pulse JS sent for the showing flow (stored only; see UiState). */
  internal var hasTake = false
    private set

  private val callbacks =
    object : Application.ActivityLifecycleCallbacks {
      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

      override fun onActivityStarted(activity: Activity) = Unit

      override fun onActivityResumed(activity: Activity) {
        resumed = WeakReference(activity)
        foreground = WeakReference(activity)
      }

      override fun onActivityPaused(activity: Activity) {
        if (resumed?.get() === activity) resumed = null
      }

      override fun onActivityStopped(activity: Activity) {
        if (foreground?.get() === activity) foreground = null
      }

      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

      override fun onActivityDestroyed(activity: Activity) {
        if (resumed?.get() === activity) resumed = null
        if (foreground?.get() === activity) foreground = null
      }
    }

  /**
   * Starts following the app's Activities, once per process, for [currentActivity] and [state].
   * PulseKit calls it from its init (it is the "lifecycle callbacks PulseKit registered"); the
   * presenter and PulseActivity also call it, so it works even if PulseKit hasn't yet. [seed] is an
   * Activity known to be in front when tracking starts late.
   */
  internal fun track(application: Application, seed: Activity? = null) {
    if (tracking) return
    tracking = true
    appContext = application.applicationContext
    application.registerActivityLifecycleCallbacks(callbacks)
    if (seed != null && alive(seed)) {
      val at = lifecycleOf(seed)
      if (at == null || at.isAtLeast(Lifecycle.State.STARTED)) foreground = WeakReference(seed)
      if (at?.isAtLeast(Lifecycle.State.RESUMED) == true) resumed = WeakReference(seed)
    }
  }

  // region PresenterPort

  override fun launch(activity: Activity, launcher: PulseOpenLauncher?, launch: FlowLaunch) {
    track(activity.application, activity)
    val id = launch.requestId
    val flow = launch.mode != PulseActivity.MODE_PREPARING
    // Unique in this process and unlikely to repeat across processes: a screen restored after
    // process death never matches a record this process made.
    val token = SystemClock.elapsedRealtimeNanos()
    live[id] = Live(id, launch.mode, token)
    ended.remove(id)
    if (flow) {
      statusBar = "light"
      statusBarHidden = false
      hasTake = false
      // Before the Activity starts, so other apps' audio pauses as Pulse appears (iOS saves and
      // switches the session before presenting).
      PulseKitAudio.gain(activity, id)
    }
    val intent =
      Intent(activity, PulseActivity::class.java)
        // An instant cut: no system transition (Pulse's no-decorative-animation rule, as iOS).
        .addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION)
        .putExtra(PulseActivity.EXTRA_REQUEST_ID, id)
        .putExtra(PulseActivity.EXTRA_MODE, launch.mode)
        .putExtra(PulseActivity.EXTRA_REQUEST, launch.requestJson)
        .putExtra(PulseActivity.EXTRA_PROPS, launch.props)
        .putExtra(PulseActivity.EXTRA_LAUNCH, token)
    try {
      if (launcher != null) {
        launcher.launch(activity, intent)
      } else {
        activity.startActivity(intent)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
          @Suppress("DEPRECATION") activity.overridePendingTransition(0, 0)
        }
      }
      Log.i(TAG, "open $id: started PulseActivity (${launch.mode})")
    } catch (e: RuntimeException) {
      // The Activity is missing from the merged manifest, or the launcher threw. Nothing will
      // show, so the flow ends now rather than waiting forever for a screen.
      Log.e(TAG, "open $id: couldn't start PulseActivity", e)
      live.remove(id)
      PulseKitAudio.release(activity, id)
      if (flow) {
        val app = activity.applicationContext
        // Posted: the facade records the flow after launch() returns.
        main.post { PulseKit.shared(app).flows.onViewGone(id, "interrupted") }
      }
    }
  }

  override fun dismiss(requestId: String) {
    val record = live[requestId]
    if (record == null) {
      Log.i(TAG, "dismiss $requestId: nothing showing")
      return
    }
    record.dismissed = true
    appContext?.let { PulseKitAudio.release(it, requestId) }
    val screen = record.screen?.get()
    if (screen == null) {
      // Started but not created yet (or between a configuration change's two instances): the
      // next PulseActivity for it finishes as it opens (Attach.DISMISSED).
      Log.i(TAG, "dismiss $requestId: its screen isn't up yet; it closes as it opens")
      return
    }
    screen.finishDismissed()
  }

  override fun applyUi(ui: UiState) {
    val record =
      live.values.firstOrNull { it.mode != PulseActivity.MODE_PREPARING && !it.dismissed }
    if (record == null) return // dropped while no flow is open (§8.1)
    ui.statusBar?.let { statusBar = it }
    ui.statusBarHidden?.let { statusBarHidden = it }
    ui.hasTake?.let { hasTake = it }
    record.screen?.get()?.applySystemBars()
  }

  /**
   * - NONE: no Activity.
   * - DETACHED: finishing or destroyed; or, on Android 10+, stopped with none of the app's
   *   Activities in front (the app is in the background, where Android refuses to start an
   *   Activity, so a start would be lost and `open` would never be answered).
   * - PRESENTING: not resumed because another of the app's Activities is in front (its own
   *   screen, a dialog Activity, or PulseActivity's "Preparing…").
   * - IDLE: otherwise (resumed, or visible under a system dialog or the notification shade).
   */
  override fun state(activity: Activity?): PresenterState {
    if (activity == null) return PresenterState.NONE
    track(activity.application, activity)
    if (!alive(activity)) return PresenterState.DETACHED
    val at = lifecycleOf(activity)
    val isResumed = at?.isAtLeast(Lifecycle.State.RESUMED) ?: (resumed?.get() === activity)
    if (isResumed) return PresenterState.IDLE
    val front = (resumed?.get() ?: foreground?.get())?.takeIf { it !== activity && alive(it) }
    if (front != null) return PresenterState.PRESENTING
    val stopped = at != null && !at.isAtLeast(Lifecycle.State.STARTED)
    if (stopped && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return PresenterState.DETACHED
    return PresenterState.IDLE
  }

  override fun currentActivity(): Activity? =
    foreground?.get()?.takeIf(::alive) ?: resumed?.get()?.takeIf(::alive)

  // endregion

  // region PulseActivity's side

  /** PulseActivity.onCreate: claims the record for [requestId] and says what to do. */
  internal fun attach(screen: PulseActivity, requestId: String, token: Long): Attach {
    val record = live[requestId]
    if (record == null || record.token != token) {
      return if (requestId in ended) Attach.ENDED else Attach.UNKNOWN
    }
    if (record.dismissed) {
      end(requestId)
      return Attach.DISMISSED
    }
    record.screen = WeakReference(screen)
    return Attach.MOUNT
  }

  /** PulseActivity.onDestroy: lets go of [screen] and says what to report. */
  internal fun detach(
    screen: PulseActivity,
    requestId: String,
    token: Long,
    changingConfigurations: Boolean,
  ): Detach {
    val record = live[requestId]
    if (record == null || record.token != token || record.screen?.get() !== screen) {
      return Detach.NOT_OWNER
    }
    record.screen = null
    return when {
      record.dismissed -> {
        end(requestId)
        Detach.DISMISSED
      }
      changingConfigurations -> Detach.CONFIG_CHANGE
      else -> {
        end(requestId)
        Detach.GONE
      }
    }
  }

  /** The status bar the showing flow asked for: `"light"`, `"dark"` or `"auto"`, and hidden. */
  internal fun statusBar(): Pair<String, Boolean> = statusBar to statusBarHidden

  // endregion

  private fun end(requestId: String) {
    live.remove(requestId)
    ended.remove(requestId)
    ended.add(requestId)
    while (ended.size > ENDED_KEPT) ended.remove(ended.first())
  }

  private fun alive(activity: Activity): Boolean = !activity.isFinishing && !activity.isDestroyed

  private fun lifecycleOf(activity: Activity): Lifecycle.State? =
    (activity as? LifecycleOwner)?.lifecycle?.currentState
}
