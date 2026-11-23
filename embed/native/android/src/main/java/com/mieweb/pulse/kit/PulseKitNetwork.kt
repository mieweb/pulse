// Mirrors `PulseKitNetwork` at the end of embed/native/ios/PulseKit.swift (NWPathMonitor). Q6:
// PulseKit is Pulse JS's only network source (no expo-network), so the facade's catalog reads and
// Pulse JS's job loop derive `waiting_network` from the same values.

package com.mieweb.pulse.kit

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import com.mieweb.pulse.kit.core.PulseJson

/**
 * The device's network, from ConnectivityManager's default-network callback (API 24).
 *
 * - `online`: the default network is validated (it reached the internet; a captive portal isn't).
 * - `wifi`: it runs over Wi-Fi or Ethernet, not cellular (Swift counts a wire too).
 * - `expensive`: the system says it is metered (cellular, a hotspot, a Wi-Fi marked metered).
 *
 * Changes arrive on the main thread, and only when something changed. Needs
 * ACCESS_NETWORK_STATE, which the AAR's manifest declares.
 */
internal class PulseKitNetwork(context: Context) {
  /**
   * One reading. Until the first one (taken at [start]), a usable network is assumed: queued
   * drafts then show as queued rather than waiting.
   */
  data class State(
    val online: Boolean = true,
    val wifi: Boolean = true,
    val expensive: Boolean = false,
  ) {
    /** As Pulse JS reads it (initial props `network`, `pulse.cmd network`). */
    val json: PulseJson
      get() = PulseJson.obj(
        "online" to PulseJson.Bool(online),
        "wifi" to PulseJson.Bool(wifi),
        "expensive" to PulseJson.Bool(expensive),
      )
  }

  private val app: Context = context.applicationContext ?: context
  private val main = Handler(Looper.getMainLooper())

  /** The latest reading; read and written on the main thread. */
  var state = State()
    private set

  /** Called with the old and the new state, on the main thread, only when something changed. */
  var onChange: ((State, State) -> Unit)? = null

  private var started = false

  /** Take the first reading now and follow the default network from here on. Main thread. */
  fun start() {
    if (started) return
    started = true
    val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    try {
      val active = cm.activeNetwork
      state = if (active == null) {
        State(online = false, wifi = false, expensive = false)
      } else {
        read(cm.getNetworkCapabilities(active))
      }
    } catch (e: SecurityException) {
      pulseKitLog("network: can't read the network (${e.message}); assuming online")
    }
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        // Before API 26 the capabilities don't always follow onAvailable: read them here too.
        val caps = try {
          cm.getNetworkCapabilities(network)
        } catch (e: SecurityException) {
          null
        }
        if (caps != null) post(read(caps))
      }

      override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
        post(read(caps))
      }

      override fun onLost(network: Network) {
        post(State(online = false, wifi = false, expensive = false))
      }
    }
    try {
      cm.registerDefaultNetworkCallback(callback)
    } catch (e: RuntimeException) {
      // SecurityException without the permission, or too many callbacks in this app.
      pulseKitLog("network: no default-network callback (${e.message}); the first reading stays")
    }
  }

  private fun read(caps: NetworkCapabilities?): State {
    if (caps == null) return State(online = false, wifi = false, expensive = false)
    return State(
      online = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
      wifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
        caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET),
      expensive = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED),
    )
  }

  private fun post(next: State) {
    main.post {
      if (next == state) return@post
      val old = state
      state = next
      onChange?.invoke(old, next)
    }
  }
}
