// Mirrors embed/native/ios/PulseKitPresenter.swift (`PulseKitAudioState`): other apps' audio
// pauses while a Pulse flow is up and resumes after it closes. Android has no process-wide
// session category to save and put back, so audio focus does the same job (PR4-SPEC "Android
// differences": presentation).
package com.mieweb.pulse.kit

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.util.Log

/**
 * PulseKit's audio focus for one flow at a time (G6 "Audio"). [gain] runs when a flow is
 * launched and [release] when its PulseActivity finishes; nothing else here touches audio, so the
 * host's own audio state (mode, routing, volume, its own focus requests) stays the host's.
 *
 * The request is `AUDIOFOCUS_GAIN_TRANSIENT`, not `AUDIOFOCUS_GAIN`: a music app that loses
 * focus permanently (`AUDIOFOCUS_LOSS`) stops and doesn't come back, while a transient loss tells
 * it to pause and resume when focus returns, which is what iOS's
 * `setActive(false, .notifyOthersOnDeactivation)` does for the device check ("playing within 2 s
 * of close"). Pulse's own players (the editor's preview) request focus for themselves; when they
 * do, this request loses focus, which is logged and otherwise ignored.
 *
 * Main thread only, like everything the presenter does.
 */
internal object PulseKitAudio {
  private const val TAG = "PulseKit"

  /** The requestId of the flow holding focus, or null. */
  private var holder: String? = null

  /** The API 26+ request, kept to abandon the same one. */
  private var request: AudioFocusRequest? = null

  private val listener = AudioManager.OnAudioFocusChangeListener { change ->
    Log.i(TAG, "audio focus for ${holder ?: "no flow"} changed: $change")
  }

  /**
   * Takes audio focus for the flow [requestId]. Calling it again while that flow (or another;
   * there is one flow at a time) holds focus only moves the holder, so nothing is requested twice.
   */
  fun gain(context: Context, requestId: String) {
    if (holder != null) {
      holder = requestId
      return
    }
    val audio = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    if (audio == null) {
      Log.w(TAG, "open $requestId: no AudioManager; other apps' audio keeps playing")
      return
    }
    val granted =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val req =
          AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(
              AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                .build()
            )
            .setOnAudioFocusChangeListener(listener)
            .build()
        request = req
        audio.requestAudioFocus(req)
      } else {
        @Suppress("DEPRECATION")
        audio.requestAudioFocus(
          listener,
          AudioManager.STREAM_MUSIC,
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
        )
      }
    // Held either way: a refusal (a phone call) still needs the matching abandon later.
    holder = requestId
    if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      Log.i(TAG, "open $requestId: audio focus not granted ($granted); other audio may play on")
    }
  }

  /**
   * Gives focus back when the flow [requestId] holds it, so a paused music app resumes. A
   * [requestId] that doesn't hold focus (a flow that never took it, or a second call) does nothing.
   */
  fun release(context: Context, requestId: String) {
    if (holder != requestId) return
    holder = null
    val audio = context.applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    val req = request
    request = null
    if (audio == null) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (req != null) audio.abandonAudioFocusRequest(req)
    } else {
      @Suppress("DEPRECATION") audio.abandonAudioFocus(listener)
    }
    Log.i(TAG, "open $requestId: audio focus given back")
  }
}
