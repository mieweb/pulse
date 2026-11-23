// The internal seams between PulseKit's facade (PR4-C) and its presenter (PR4-D), frozen in PR4
// wave 1 so both code against them without each other's files (PR4-SPEC "Frozen names"). They
// stand where PulseKit.swift and PulseKitPresenter.swift call each other directly. No logic.
package com.mieweb.pulse.kit

import android.app.Activity
import android.os.Bundle
import com.mieweb.pulse.kit.core.PresenterState

/**
 * One flow for the presenter to show.
 *
 * @property requestId The `open` request's id; every later message about the flow names it.
 * @property mode `"flow"` (Pulse's screens for `open`) or `"preparing"` (the "Preparing…" screen
 *   while a host write waits for Pulse JS).
 * @property requestJson The `open` request envelope, kept so a recreated Activity can report the
 *   flow it lost (`FlowPort.onRecreatedWithoutFlow`); null for `"preparing"`.
 * @property props The React root's initial props.
 */
internal data class FlowLaunch(
  val requestId: String,
  val mode: String,
  val requestJson: String?,
  val props: Bundle,
)

/**
 * What Pulse JS asks of the screen around it (`pulse.ui`, as PulseKitContainerViewController
 * takes it on iOS). A null field leaves that setting as it is.
 *
 * @property statusBar `"light"`, `"dark"` or `"auto"` status-bar content (auto follows uiMode).
 * @property statusBarHidden Whether the status bar is hidden.
 * @property hasTake Whether a take would be lost if the flow ended now. Stored for PulseKit's
 *   fallback result; Android has no swipe-to-dismiss to lock.
 */
internal data class UiState(
  val statusBar: String?,
  val statusBarHidden: Boolean?,
  val hasTake: Boolean?,
)

/**
 * Shows and hides Pulse's screens. PR4-D implements it as `internal object PulseKitPresenter`
 * (PulseActivity and the "Preparing…" screen); PR4-C's facade calls it. Every method runs on the
 * main thread.
 */
internal interface PresenterPort {
  /**
   * Opens [launch] over [activity], through [launcher] when the host gave one, else
   * `activity.startActivity`.
   */
  fun launch(activity: Activity, launcher: PulseOpenLauncher?, launch: FlowLaunch)

  /** Closes the flow [requestId] if it's the one showing; otherwise does nothing. */
  fun dismiss(requestId: String)

  /** Applies a `pulse.ui` message to the showing flow. */
  fun applyUi(ui: UiState)

  /** Where presentation stands, given the host Activity a call came with (or null). */
  fun state(activity: Activity?): PresenterState

  /** The app's foreground Activity (from PulseKit's lifecycle callbacks), or null. */
  fun currentActivity(): Activity?
}

/**
 * What happens to a flow's screen, told to the facade. PR4-C implements it as `PulseKit.flows`;
 * PR4-D's presenter and PulseActivity call it on the main thread, and PR4-C's fatal-error hook
 * calls [onFatal].
 */
internal interface FlowPort {
  /** The flow [requestId] is on screen. */
  fun onShown(requestId: String)

  /**
   * The flow's screen went away without Pulse JS or the facade closing it. [reason] is
   * `"interrupted"` (PulseActivity finished, for example when the host's task cleared it) or
   * `"system"` (the system destroyed it).
   */
  fun onViewGone(requestId: String, reason: String)

  /**
   * PulseActivity came back after process death with no flow to resume; [requestJson] is the open
   * request it saved, if any.
   */
  fun onRecreatedWithoutFlow(requestId: String, requestJson: String?)

  /** React Native failed fatally (S1-g) while a flow or a command runtime was up. */
  fun onFatal(error: Throwable)
}
