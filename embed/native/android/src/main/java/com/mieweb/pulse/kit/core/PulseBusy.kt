// Mirrors embed/native/ios/PulseKitEnvelope.swift (`PulsePresenterState`, `PulseOpenDecision`,
// `PulseOpenGate`): one flow at a time, native-bridge.md §3's busy matrix. Checked by
// envelope.json's `busy` section on the JVM.

package com.mieweb.pulse.kit.core

/**
 * What the Activity the host passed to `open` can do. The names and their [wire] values are the
 * Swift ones; the meaning is Android's, since Pulse runs in its own Activity rather than a view
 * controller presented over the host's.
 */
enum class PresenterState(val wire: String) {
  /** No Activity was passed (the plugin had none to give). */
  NONE("none"),

  /** The Activity is resumed and not finishing: Pulse can start over it. */
  IDLE("idle"),

  /**
   * The host Activity is paused under another Activity of the host (its own screen, a dialog
   * Activity): starting Pulse now would cover a screen the host is showing, as iOS refuses to
   * present over a presented view controller.
   */
  PRESENTING("presenting"),

  /**
   * The Activity is finishing or destroyed: a start from it would be lost with it, and the `open`
   * reply would never come (iOS: the view controller isn't in a window).
   */
  DETACHED("detached");

  /** Lookup by [wire] value. */
  companion object {
    /** The state named [wire], or null. */
    @JvmStatic
    fun fromWire(wire: String?): PresenterState? = values().firstOrNull { it.wire == wire }
  }
}

/** What `open` does, given the open flow, the presenter and the inbox. */
enum class OpenDecision(val wire: String) {
  /** Present a new flow. */
  START("start"),

  /** The same requestId is open: wait for the same result. */
  JOIN("join"),

  /** Another flow is open, or the host is showing another screen. */
  BUSY("busy"),

  /** There is nothing to start from. */
  NO_PRESENTER("noPresenter"),

  /**
   * This requestId already ended and its result is still in the inbox (not acknowledged): answer
   * with that result and present nothing. A new flow under the same id would be answered with the
   * old file, and its own result would replace one the host hasn't seen.
   */
  DELIVERED("delivered"),
}

/** The one-flow gate. */
object PulseBusy {
  /**
   * The open flow comes first: its own Activity makes the presenter look busy, and the same
   * requestId must still join it. Then an unacknowledged result for the requestId
   * ([pendingInInbox]) answers the open, whatever the presenter is doing, since nothing is
   * presented. Then the presenter decides.
   */
  @JvmStatic
  @JvmOverloads
  fun decideOpen(
    openRequestId: String?,
    requestId: String?,
    presenter: PresenterState,
    pendingInInbox: Boolean = false,
  ): OpenDecision {
    if (openRequestId != null) {
      return if (requestId == openRequestId) OpenDecision.JOIN else OpenDecision.BUSY
    }
    if (pendingInInbox && requestId != null) return OpenDecision.DELIVERED
    return when (presenter) {
      PresenterState.NONE -> OpenDecision.NO_PRESENTER
      PresenterState.PRESENTING, PresenterState.DETACHED -> OpenDecision.BUSY
      PresenterState.IDLE -> OpenDecision.START
    }
  }
}
