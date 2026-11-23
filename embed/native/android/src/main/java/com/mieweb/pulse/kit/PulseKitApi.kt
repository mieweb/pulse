// The callbacks of PulseKit's public Android API (frozen in PR4; PR4-SPEC "Frozen names").
// Mirrors the closures PulseKit.swift takes (`call(_:reply:)`, `setEventListener`, the open
// launcher); fun interfaces so Java hosts pass lambdas and Kotlin hosts pass function literals.
// No logic lives here.
package com.mieweb.pulse.kit

import android.app.Activity
import android.content.Intent

/**
 * Receives the reply to one `PulseKit.call`: a JSON envelope (native-bridge.md §2), exactly one per
 * call. PulseKit calls it on the main thread.
 */
fun interface PulseReply {
  /** @param json The reply envelope, `{"v":1,"id":…,"ok":…}`. */
  fun onReply(json: String)
}

/**
 * Receives PulseKit's events (`flowResult`, `inbox`, `upload`, …) as JSON envelopes, on the main
 * thread. A host sets one with `PulseKit.setEventListener`; setting another replaces it.
 */
fun interface PulseEventListener {
  /** @param json The event envelope (native-bridge.md §3). */
  fun onEvent(json: String)
}

/**
 * Starts `PulseActivity` for a host that needs to own the launch: the Capacitor plugin passes one
 * that goes through its Activity-result bridge, so a result survives the host Activity's death
 * (`appRestoredResult`). Without one, PulseKit calls `activity.startActivity(intent)` itself.
 */
fun interface PulseOpenLauncher {
  /**
   * @param activity The host Activity the flow opens over.
   * @param intent The `PulseActivity` intent PulseKit built (its extras are PulseActivity's
   *   `EXTRA_*` names).
   */
  fun launch(activity: Activity, intent: Intent)
}
