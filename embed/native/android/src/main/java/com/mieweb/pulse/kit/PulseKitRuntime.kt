// Mirrors the "Pulse JS", "Host writes", "Host requests" and "Lifetime" parts of
// embed/native/ios/PulseKit.swift: the BrownfieldMessaging side of the facade (native-bridge.md
// §8.1). PulseKit.kt keeps the transport, the native answers and the flow; this file keeps Pulse
// JS's runtime: booting it, its messages, the writes forwarded to it, host requests, memory
// pressure and fatal errors.

package com.mieweb.pulse.kit

import android.app.Activity
import android.os.Bundle
import android.os.Looper
import com.mieweb.pulse.kit.core.PulseContract
import com.mieweb.pulse.kit.core.PulseError
import com.mieweb.pulse.kit.core.PulseJson
import com.mieweb.pulse.kit.core.PulseRequest
import com.mieweb.pulse.kit.core.PulseReply as ReplyEnvelope
import expo.modules.brownfield.BrownfieldMessaging
import java.util.UUID

/**
 * Pulse JS's runtime as the facade sees it. Main thread only, like PulseKit; the messaging
 * listener hops there.
 *
 * - The runtime boots once (ReactNativeHostManager) and outlives each flow. Its namespace
 *   ([runtimeNamespace]) is fixed by the first root's storage roots until it is released.
 * - Host writes go to Pulse JS as `pulse.cmd` once it says `pulse.ready`, each answered by one
 *   `pulse.reply` within its deadline (30 s, or the client's `timeoutMs` from 1 s to 10 min), a
 *   cold boot included. A cold runtime boots under "Preparing…" (PulseActivity in mode
 *   `preparing`) from the Activity in front; with none, the write answers `runtime.paused` (an
 *   Activity can't be started from the background; [PulseKitInfo.HEADLESS] is off on Android).
 * - Host requests (§5) are kept until answered or their 20 s deadline; then Pulse JS hears
 *   `pulse.cmd hostTimeout`.
 * - Memory pressure (C6) asks Pulse JS whether it is idle, then releases the instance
 *   (`ReactNativeHostManager.release`), never while a flow is open.
 * - A fatal error inside React Native (S1-g) fails the open flow and the waiting writes, and the
 *   next use starts a fresh instance.
 */
internal class PulseKitRuntime(private val kit: PulseKit) {
  /** A host write forwarded to Pulse JS. */
  private class Forwarded(
    val request: PulseRequest,
    val deadlineMs: Long,
    val reply: (String) -> Unit,
    val sequence: Int,
  ) {
    /** Sent as `pulse.cmd`; until then it waits for `pulse.ready`. */
    var sent = false

    /** The "Preparing…" screen is up for it, and closes once no such call is left. */
    var preparing = false

    var timeout: Runnable? = null
  }

  /** Pulse JS's command handlers are up (`pulse.ready`) in the bound runtime. */
  var jsReady = false
    private set

  /** Set by a fatal error, or a command root that couldn't start: the next use starts fresh. */
  private var runtimeBroken = false

  /**
   * Set once Pulse JS let go of its library (a purge's `releaseLibrary`, a memory release,
   * `pulse.released`): its database is closed and can't reopen in that runtime, so the next use
   * starts a fresh React Native instance.
   */
  private var runtimeReleased = false

  /** `ReactNativeHostManager.release` already ran for the current instance. */
  private var instanceDestroyed = false

  /**
   * The namespace whose folders Pulse JS was given (the first root's): its storage roots and
   * database are fixed for the runtime's life, so setAccount for another one is
   * `restart_required` (§4). Null before that, and again once the runtime is released.
   */
  var runtimeNamespace: String? = null
    private set(value) {
      field = value
      pulseRuntimeUp = value != null
    }

  /** [runtimeNamespace] != null, readable from the thread a fatal error lands on. */
  @Volatile private var pulseRuntimeUp = false

  /** The namespace Pulse JS is fixed to, unless a fatal error means the next use starts fresh. */
  val boundNamespace: String? get() = if (runtimeBroken) null else runtimeNamespace

  /** `pulse.cmd`s waiting for their `pulse.reply`, by callId. */
  private val commands = HashMap<String, (PulseJson) -> Unit>()

  /** Host writes waiting for Pulse JS's `pulse.reply`, by callId. */
  private val forwarded = LinkedHashMap<String, Forwarded>()
  private var forwardSequence = 0

  /** The "Preparing…" screen's FlowLaunch id while it is up. */
  var preparingId: String? = null
    private set

  /**
   * A `memoryWarning` waiting for Pulse JS's answer: opens and forwarded calls wait for it too,
   * so nothing mounts on, or is sent to, a runtime that may be letting go of its library.
   */
  var memoryCheck: String? = null
    private set

  /** Opens that came during a memory check, run once it is answered (or dropped). */
  private val deferredOpens = mutableListOf<() -> Unit>()

  /** Host requests (§5) not answered yet: each one's deadline. */
  private val hostRequests = HashMap<String, Runnable>()

  private var listenerId: String? = null

  // Booting

  /**
   * Listen to Pulse JS's messages, for the process's life. BrownfieldMessaging calls back on the
   * JS thread; each message is read there and handled on the main thread. `pulse.upload*` is
   * PulseKitUploads' (PR4-E) and is skipped here.
   */
  fun listen() {
    if (listenerId != null) return
    listenerId = BrownfieldMessaging.addListener { message ->
      val type = message["type"] as? String ?: return@addListener
      if (type.startsWith("pulse.upload")) return@addListener
      val value = PulseJson.fromAny(message)
      kit.onMain { onMessage(value) }
    }
  }

  /**
   * Bring up the React host once (ReactNativeHostManager.initialize: no storage roots; the first
   * root's props bring those); after a fatal error or a release, drop the old instance so the
   * next root starts a fresh one. False when React Native can't start here (a release build
   * without its JS bundle, say).
   */
  fun startRuntime(): Boolean {
    val application = kit.application ?: run {
      kit.log("React Native can't start: no Application context")
      return false
    }
    try {
      ReactNativeHostManager.shared.initialize(application)
    } catch (e: RuntimeException) {
      kit.log("React Native can't start: ${e.message}")
      return false
    }
    if (runtimeBroken || runtimeReleased) {
      kit.log(
        "starting a fresh React Native instance after " +
          (if (runtimeBroken) "a fatal error" else "Pulse JS let go of its library"),
      )
      if (!instanceDestroyed) releaseInstance("PulseKit: a fresh instance")
      runtimeBroken = false
      runtimeReleased = false
      // A fresh JS runtime takes new storage roots: no namespace is bound until the next root.
      runtimeNamespace = null
      jsReady = false
    }
    instanceDestroyed = false
    installFatalHandler()
    return true
  }

  /** A root now runs Pulse JS in [namespace] (an open's flow, or the command root). */
  fun bind(namespace: String) {
    runtimeNamespace = namespace
  }

  /**
   * Pulse JS let go of the library for a purge, or didn't in time: never send that runtime another
   * command; the next use starts a fresh instance.
   */
  fun dropBinding() {
    runtimeReleased = true
    runtimeNamespace = null
    jsReady = false
  }

  private fun releaseInstance(reason: String) {
    instanceDestroyed = true
    try {
      ReactNativeHostManager.shared.release(reason)
    } catch (e: RuntimeException) {
      kit.log("releasing React Native failed: ${e.message}")
    }
  }

  // Messages from Pulse JS (§8.1)

  private fun onMessage(message: PulseJson) {
    when (message["type"]?.string) {
      "pulse.result" -> {
        val requestId = message["requestId"]?.string ?: return
        kit.onResultMessage(requestId, runtimeNamespace)
      }
      "pulse.error" -> {
        val text = message["message"]?.string ?: "Pulse couldn't open."
        val requestId = message["requestId"]?.string
        val flow = kit.flow
        if (flow != null && flow.requestId == requestId) {
          kit.finish(kit.failed(flow, text))
        } else if (requestId.isNullOrEmpty() && flow == null) {
          // The command runtime's root couldn't start: its writes fail, and the next one boots a
          // fresh instance.
          kit.log("the command runtime couldn't start: $text")
          runtimeBroken = true
          jsReady = false
          failForwarded("runtime.error", text)
        }
      }
      "pulse.ready" -> {
        jsReady = true
        kit.log("Pulse JS takes commands in ${message["namespace"]?.string ?: "?"}")
        val bound = runtimeNamespace
        if (bound != null && kit.accounts.namespace != bound) {
          sendCommand(
            "accountActive",
            PulseJson.obj("active" to PulseJson.Bool(false)),
            expectReply = false,
          )
        }
        // The host's options now, in case `configure` came while the runtime booted on older ones.
        sendCommand(
          "configure",
          PulseJson.Obj(kit.effectiveConfig("pulse.ready", quiet = true)),
          expectReply = false,
        )
        sendWaitingCommands()
      }
      "pulse.released" -> {
        // Pulse JS let go of its library for good (lifetime.ts, commands/runtime.ts): it gets no
        // more commands, and the next use starts a fresh instance. A purge or a memory check
        // waiting for this answer finishes the job from its reply.
        jsReady = false
        runtimeReleased = true
        kit.log("Pulse JS let go of ${message["namespace"]?.string ?: "?"}")
        if (kit.flow == null && kit.purging == null && memoryCheck == null) {
          runtimeNamespace = null
          resumeWaitingCommands()
        }
      }
      "pulse.reply" -> {
        val callId = message["callId"]?.string ?: return
        val done = commands.remove(callId) ?: return
        done(message)
      }
      "pulse.event" -> {
        val name = message["name"]?.string ?: return
        val payload = message["payload"] ?: PulseJson.Null
        if (name == "hostRequest") trackHostRequest(payload)
        kit.emit(name, payload)
      }
      "pulse.ui" -> kit.applyUi(message)
      else -> Unit
    }
  }

  /**
   * `pulse.cmd` to Pulse JS; its `pulse.reply` goes to [done]. With [expectReply] false (a notice
   * such as `network`) nothing waits for one. Returns the command's callId: [callId] when given
   * (a forwarded call keeps the host's, so native and JS log lines name the same call), else a
   * fresh `n-…`. [flowScoped] commands are dropped when the open flow ends (its root may never
   * answer); the runtime's own (forwarded writes, memoryWarning) aren't.
   */
  fun sendCommand(
    method: String,
    args: PulseJson,
    expectReply: Boolean = true,
    callId: String? = null,
    flowScoped: Boolean = true,
    done: ((PulseJson) -> Unit)? = null,
  ): String {
    val id = callId ?: ("n-" + UUID.randomUUID().toString().replace("-", "").take(12))
    if (expectReply) {
      if (flowScoped) kit.flow?.commandIds?.add(id)
      commands[id] = done ?: { reply ->
        if (reply["ok"]?.bool == false) {
          kit.log("pulse.cmd $method $id failed: ${reply["error"]?.get("code")?.string ?: "?"}")
        }
      }
    }
    BrownfieldMessaging.sendMessage(
      mapOf("type" to "pulse.cmd", "callId" to id, "method" to method, "args" to toMessage(args)),
    )
    return id
  }

  /** Forget a command's reply handler; true when one was waiting. */
  fun dropCommand(callId: String): Boolean = commands.remove(callId) != null

  // Host writes (§3 "JS")

  /**
   * Forward a host write to Pulse JS: at once when its runtime takes commands, else once it does
   * (booting it if it isn't up). The reply is Pulse JS's, or `timeout` at the deadline.
   */
  fun forward(req: PulseRequest, timeoutMs: Long?, activity: Activity?, reply: (String) -> Unit) {
    val callId = req.callId
    val refuse = { r: ReplyEnvelope ->
      kit.log("${req.method} $callId: ${r.error?.code ?: "?"}")
      reply(r.serialized)
    }
    if (kit.purging != null) {
      return refuse(ReplyEnvelope.failure("busy", "Pulse is deleting a library.", callId))
    }
    val ns = kit.accounts.namespace ?: return refuse(kit.noAccount(callId))
    val bound = boundNamespace
    if (bound != null && bound != ns) {
      return refuse(
        ReplyEnvelope.failure(
          "restart_required",
          "Pulse has another account's library open; restart the app.",
          callId,
        ),
      )
    }
    if (forwarded.containsKey(callId) || commands.containsKey(callId)) {
      return refuse(
        ReplyEnvelope.failure("invalid_options", "callId $callId is already waiting.", callId),
      )
    }
    forwardSequence += 1
    val call = Forwarded(req, forwardDeadlineMs(timeoutMs), reply, forwardSequence)
    forwarded[callId] = call
    call.timeout = kit.after(call.deadlineMs) { forwardTimedOut(callId) }

    if (boundNamespace == null) {
      bootCommandRuntime(call, activity)
    } else if (!jsReady && preparingId != null) {
      call.preparing = true // the "Preparing…" screen already up waits for this one too
    }
    sendWaitingCommands()
  }

  /** Send every forwarded call still waiting, oldest first, once Pulse JS takes commands. */
  private fun sendWaitingCommands() {
    if (!jsReady || memoryCheck != null) return
    for (call in forwarded.values.filter { !it.sent }.sortedBy { it.sequence }) {
      call.sent = true
      val callId = call.request.callId
      kit.log("${call.request.method} $callId: to Pulse JS")
      sendCommand(
        call.request.method,
        PulseJson.Obj(call.request.args),
        callId = callId,
        flowScoped = false,
      ) { reply -> forwardReplied(callId, reply) }
    }
  }

  private fun forwardReplied(callId: String, message: PulseJson) {
    val call = forwarded.remove(callId) ?: return
    call.timeout?.let { kit.cancel(it) }
    val ok = message["ok"]?.bool == true
    val outcome = if (ok) "ok" else message["error"]?.get("code")?.string ?: "error"
    kit.log("${call.request.method} $callId: $outcome")
    call.reply(forwardedReply(message, callId))
    closePreparingIfDone()
  }

  private fun forwardTimedOut(callId: String) {
    val call = forwarded.remove(callId) ?: return
    commands.remove(callId)
    kit.log("${call.request.method} $callId: no answer in ${call.deadlineMs / 1000} s")
    call.reply(
      ReplyEnvelope.failure(
        "timeout",
        "Pulse didn't answer ${call.request.method} in time.",
        callId,
      ).serialized,
    )
    closePreparingIfDone()
  }

  /** Fail every forwarded call with [code] (the runtime died, or couldn't start). */
  fun failForwarded(code: String, message: String) {
    val calls = forwarded.values.sortedBy { it.sequence }
    forwarded.clear()
    for (call in calls) {
      call.timeout?.let { kit.cancel(it) }
      commands.remove(call.request.callId)
      call.reply(ReplyEnvelope.failure(code, message, call.request.callId).serialized)
    }
    closePreparingIfDone()
  }

  /** Whether host writes are waiting or running (purge refuses then). */
  val hasForwarded: Boolean get() = forwarded.isNotEmpty()

  /**
   * Boot Pulse's runtime for host writes, on the active account's library, under the
   * "Preparing…" screen. Pulse JS says `pulse.ready` once its command handlers are up, and the
   * waiting calls go then.
   */
  private fun bootCommandRuntime(call: Forwarded, activity: Activity?) {
    val callId = call.request.callId
    val fail = { r: ReplyEnvelope ->
      forwarded.remove(callId)
      call.timeout?.let { kit.cancel(it) }
      kit.log("${call.request.method} $callId: ${r.error?.code ?: "?"}")
      call.reply(r.serialized)
    }
    val roots = try {
      kit.accounts.activeRoots() ?: return fail(kit.noAccount(callId))
    } catch (e: java.io.IOException) {
      return fail(
        ReplyEnvelope.failure("unknown", "Pulse's folders aren't available: ${e.message}", callId),
      )
    }
    // Without an Activity in front to start "Preparing…" from, nothing boots (O2: the host shows
    // "Paused · Tap to resume"; an Activity can't be started from the background).
    val from = kit.launchActivity(activity) ?: return fail(
      ReplyEnvelope.failure(
        "runtime.paused",
        "Pulse can't start while the app isn't on screen; try again from the app.",
        callId,
      ),
    )
    if (!startRuntime()) {
      return fail(ReplyEnvelope.failure("runtime.error", "Pulse couldn't start.", callId))
    }
    // The command runtime's initial props (§8.1): `request: null`, and no headless root.
    val props = LinkedHashMap<String, PulseJson>()
    props["requestId"] = PulseJson.Str("")
    props["request"] = PulseJson.Null
    props["documentsDir"] = PulseJson.Str(roots.documents.path)
    props["cachesDir"] = PulseJson.Str(roots.caches.path)
    props["modelsDir"] = PulseJson.Str(roots.models.path)
    props["namespace"] = PulseJson.Str(roots.namespace)
    props["config"] = PulseJson.Obj(kit.effectiveConfig(callId))
    props["headless"] = PulseJson.Bool(PulseKitInfo.HEADLESS)
    props["network"] = kit.network.state.json
    val id = "preparing-" + UUID.randomUUID().toString().replace("-", "").take(12)
    try {
      val launch = FlowLaunch(id, "preparing", null, PulseKitProps.bundle(props))
      kit.presenter.launch(from, null, launch)
    } catch (e: RuntimeException) {
      return fail(
        ReplyEnvelope.failure(
          "host_misconfigured",
          "Pulse's screen couldn't start (${e.javaClass.simpleName}).",
          callId,
        ),
      )
    }
    bind(roots.namespace)
    jsReady = false
    preparingId = id
    call.preparing = true
    kit.log("${call.request.method} $callId: booting Pulse under Preparing in ${roots.namespace}")
  }

  /** Close "Preparing…" once no call it was started for is left. */
  private fun closePreparingIfDone() {
    val id = preparingId ?: return
    if (forwarded.values.any { it.preparing }) return
    preparingId = null
    kit.presenter.dismiss(id)
    kit.log("\"Preparing…\" closed")
  }

  /**
   * The "Preparing…" screen went away on its own (back, the system, a task clear). The runtime
   * stays up, and the writes keep waiting until their deadlines (with no Activity in front, React
   * Native's timers may hold them: JavaTimerManager pauses with the host).
   */
  fun preparingGone(id: String) {
    if (preparingId != id) return
    preparingId = null
    forwarded.values.forEach { it.preparing = false }
    kit.log("\"Preparing…\" went away before its writes were answered")
  }

  // Host requests (§5)

  /**
   * Keep a `hostRequest` until the host answers or its deadline (20 s) passes; at the deadline it
   * is dropped, here and from the retained events, and Pulse JS hears `hostTimeout`.
   */
  private fun trackHostRequest(payload: PulseJson) {
    val hostCallId = payload["hostCallId"]?.string
    if (hostCallId.isNullOrEmpty()) return
    val nowMs = System.currentTimeMillis()
    val deadline = payload["deadline"]?.integer ?: (nowMs + HOST_REQUEST_TIMEOUT_MS)
    val delay = (deadline - nowMs).coerceIn(0L, HOST_REQUEST_TIMEOUT_MS)
    hostRequests.remove(hostCallId)?.let { kit.cancel(it) }
    hostRequests[hostCallId] = kit.after(delay) {
      if (hostRequests.remove(hostCallId) == null) return@after
      kit.dropRetainedHostRequest(hostCallId)
      kit.log("host request $hostCallId: no answer by its deadline; dropped")
      sendCommand(
        "hostTimeout",
        PulseJson.obj("hostCallId" to PulseJson.Str(hostCallId)),
        expectReply = false,
      )
    }
  }

  /**
   * `respondHostRequest {hostCallId, result? | error?}` → `pulse.respond`. An unknown or expired
   * hostCallId is a no-op (§3). The result (a token, say) is never logged.
   */
  fun respondHostRequest(req: PulseRequest, respond: (ReplyEnvelope) -> Unit) {
    val callId = req.callId
    val hostCallId = req.args["hostCallId"]?.string
    if (hostCallId.isNullOrEmpty()) {
      return respond(
        ReplyEnvelope.failure("invalid_options", "respondHostRequest needs a hostCallId.", callId),
      )
    }
    val expire = hostRequests.remove(hostCallId) ?: run {
      kit.log("respondHostRequest $callId: $hostCallId isn't waiting; dropped")
      return respond(ReplyEnvelope.success(callId))
    }
    kit.cancel(expire)
    kit.dropRetainedHostRequest(hostCallId)
    val message = LinkedHashMap<String, Any?>()
    message["type"] = "pulse.respond"
    message["hostCallId"] = hostCallId
    val error = req.args["error"]
    if (error != null && error != PulseJson.Null) {
      message["error"] = toMessage(error)
    } else {
      message["result"] = toMessage(req.args["result"] ?: PulseJson.Null)
    }
    BrownfieldMessaging.sendMessage(message)
    respond(ReplyEnvelope.success(callId))
  }

  // Lifetime (C6)

  /**
   * Memory pressure with nothing open: Pulse JS lets go of what it can, and says whether it was
   * idle (no command, no job the loop would run); if so, PulseKit releases the instance. Forwarded
   * calls and opens that come meanwhile wait for the answer ([MEMORY_CHECK_TIMEOUT_MS] at most).
   */
  fun memoryWarning() {
    if (runtimeNamespace == null || !jsReady || kit.flow != null || preparingId != null ||
      kit.purging != null || forwarded.isNotEmpty() || memoryCheck != null
    ) {
      return
    }
    kit.log("memory pressure: asking Pulse JS whether it is idle")
    val id = sendCommand("memoryWarning", PulseJson.Obj(emptyMap()), flowScoped = false) { reply ->
      memoryCheck = null
      // Kept only on a plain "keep": an error (a half-done release, or a runtime that let go
      // already and doesn't know the command) drops it like a release does.
      val ok = reply["ok"]?.bool == true
      val keep = ok && reply["result"]?.get("release")?.bool == false
      if (!keep) {
        releaseRuntime(
          if (ok) "Pulse was idle"
          else "Pulse answered ${reply["error"]?.get("code")?.string ?: "an error"}",
        )
      }
      resumeWaitingCommands()
    }
    memoryCheck = id
    kit.after(MEMORY_CHECK_TIMEOUT_MS) {
      if (memoryCheck != id) return@after
      commands.remove(id)
      memoryCheck = null
      // Pulse JS may still be closing its library: never keep a runtime in that state.
      releaseRuntime("Pulse JS didn't answer in ${MEMORY_CHECK_TIMEOUT_MS / 1000} s")
      resumeWaitingCommands()
    }
  }

  /** Whether an open must wait for a memory check; if so, [run] runs once it is answered. */
  fun deferOpen(run: () -> Unit): Boolean {
    if (memoryCheck == null) return false
    deferredOpens.add(run)
    return true
  }

  /**
   * Release the instance now (the next use starts a fresh one): Pulse JS closed its library, or
   * may have.
   */
  private fun releaseRuntime(why: String) {
    kit.log("memory pressure: $why; releasing its runtime")
    jsReady = false
    runtimeNamespace = null
    runtimeReleased = true
    releaseInstance("PulseKit: $why")
  }

  /**
   * After a memory check: run the opens that waited, then send the writes that waited, or boot for
   * them if the runtime went meanwhile (an open that started a flow boots it for them).
   */
  private fun resumeWaitingCommands() {
    val opens = deferredOpens.toList()
    deferredOpens.clear()
    for (run in opens) run()
    if (boundNamespace == null) {
      val first = forwarded.values.filter { !it.sent }.minByOrNull { it.sequence }
      if (first != null) bootCommandRuntime(first, null)
    }
    sendWaitingCommands()
  }

  // Fatal errors (S1-g)

  /**
   * JS error isolation (B3) on Android. ExpoReactHostDelegate.handleInstanceException rethrows a
   * fatal error when no Expo ReactNativeHostHandler is registered (release builds; a debug build
   * shows RedBox instead), and the rethrow ends the React thread it ran on. This handler wraps the
   * process's default uncaught-exception handler: while Pulse's runtime is up, an exception off the
   * main thread whose stack is inside React Native goes to `FlowPort.onFatal` (the open flow ends
   * `failed{runtime.error}`, the writes waiting fail, the instance is released and the next use
   * starts fresh); anything else goes to the handler that was there, so the host's own crashes
   * stay the host's. A main-thread exception always chains: swallowing it would stop the app's UI
   * loop. Installed once per process, re-installed if the host replaced it since.
   *
   * If IB-1 finds an Expo ReactNativeHostHandler registered in the PulseKit build, nothing
   * rethrows and this never fires: hook `onReactInstanceException` then instead.
   */
  private fun installFatalHandler() {
    val current = Thread.getDefaultUncaughtExceptionHandler()
    if (current is FatalHandler) return
    Thread.setDefaultUncaughtExceptionHandler(FatalHandler(current))
  }

  private inner class FatalHandler(private val previous: Thread.UncaughtExceptionHandler?) :
    Thread.UncaughtExceptionHandler {
    override fun uncaughtException(thread: Thread, error: Throwable) {
      val mainThread = thread === Looper.getMainLooper().thread
      if (pulseRuntimeUp && !mainThread && isReactNative(error)) {
        kit.flows.onFatal(error)
        return
      }
      if (previous != null) {
        previous.uncaughtException(thread, error)
      } else {
        android.os.Process.killProcess(android.os.Process.myPid())
      }
    }
  }

  /** A fatal error (main thread): fail what waits on this runtime and release it. */
  fun onFatal(error: Throwable) {
    val message = error.message ?: "Pulse stopped on an error."
    runtimeBroken = true
    jsReady = false
    failForwarded("runtime.error", "Pulse stopped on an error: $message")
    val flow = kit.flow
    if (flow != null) {
      kit.log("open ${flow.callId}: fatal JS error: ${error.javaClass.simpleName}")
      kit.finish(kit.failed(flow, message))
    } else {
      // Pulse's runtime with no flow open (the job loop, a host write): the host keeps running,
      // and the next call starts a fresh instance.
      kit.log("fatal JS error with no flow open: ${error.javaClass.simpleName}")
    }
    releaseInstance("PulseKit: a fatal error")
  }

  /** Constants and pure helpers. */
  companion object {
    /** A forwarded call's time to answer, a cold boot included (§3 Timeouts). */
    const val FORWARD_TIMEOUT_MS = 30_000L

    /** The client's `timeoutMs` is taken within this range (PR2-K: 1 s to 10 min). */
    const val FORWARD_TIMEOUT_MIN_MS = 1_000L
    const val FORWARD_TIMEOUT_MAX_MS = 600_000L

    /** A host request's time to be answered (§5, PLAN §6.4). */
    const val HOST_REQUEST_TIMEOUT_MS = 20_000L

    /**
     * A memory warning's time to be answered: Pulse JS answers within its 3 s engine budget plus
     * the library's close (lifetime.ts); without an answer by then the runtime is released.
     */
    const val MEMORY_CHECK_TIMEOUT_MS = 10_000L

    /** How long a forwarded call waits for Pulse JS: the client's own deadline, else 30 s. */
    fun forwardDeadlineMs(timeoutMs: Long?): Long =
      timeoutMs?.coerceIn(FORWARD_TIMEOUT_MIN_MS, FORWARD_TIMEOUT_MAX_MS) ?: FORWARD_TIMEOUT_MS

    /**
     * The request's `timeoutMs` (a positive whole number up to 2^31 - 1, else ignored), read from
     * the envelope as PulseKitEnvelope.swift's router reads it. core's PulseRequest doesn't carry
     * it yet (PR4-A predates PR2-K), so the facade reads it from the text.
     */
    fun timeoutMs(requestText: String): Long? {
      val t = PulseJson.parse(requestText)?.get("timeoutMs")?.integer ?: return null
      return if (t > 0 && t <= Int.MAX_VALUE) t else null
    }

    /**
     * Pulse JS's `pulse.reply` as the host's reply envelope: its result, or its error (with
     * `reason`, `draftId` and anything else it carries) under the host's callId.
     */
    fun forwardedReply(message: PulseJson, callId: String): String {
      val envelope = LinkedHashMap<String, PulseJson>()
      envelope["v"] = PulseJson.Integer(PulseContract.ENVELOPE_VERSION.toLong())
      envelope["callId"] = PulseJson.Str(callId)
      if (message["ok"]?.bool == true) {
        envelope["ok"] = PulseJson.Bool(true)
        envelope["result"] = message["result"] ?: PulseJson.Null
      } else {
        val error = LinkedHashMap(message["error"]?.obj ?: emptyMap())
        val code = error["code"]?.string ?: "unknown"
        error["code"] = PulseJson.Str(code)
        if (error["message"]?.string == null) {
          error["message"] = PulseJson.Str("Pulse couldn't do that.")
        }
        if (error["recoverable"]?.bool == null) {
          error["recoverable"] = PulseJson.Bool(PulseError.isRecoverable(code))
        }
        error["callId"] = PulseJson.Str(callId)
        envelope["ok"] = PulseJson.Bool(false)
        envelope["error"] = PulseJson.Obj(error)
      }
      return PulseJson.Obj(envelope).serialized
    }

    /**
     * A JSON value as BrownfieldMessaging carries it to Pulse JS: maps, lists, strings, booleans,
     * null, and every number as a Double (JavaScript has one number type).
     */
    fun toMessage(value: PulseJson): Any? = when (value) {
      PulseJson.Null -> null
      is PulseJson.Bool -> value.value
      is PulseJson.Integer -> value.value.toDouble()
      is PulseJson.Num -> value.value
      is PulseJson.Str -> value.value
      is PulseJson.Arr -> value.items.map { toMessage(it) }
      is PulseJson.Obj -> LinkedHashMap<String, Any?>().also { m ->
        value.fields.forEach { (k, v) -> m[k] = toMessage(v) }
      }
    }

    /**
     * Whether [error]'s stack (or a cause's) runs inside React Native's instance: a frame in
     * `com.facebook.react.` (the rethrow comes from ReactHostImpl.handleHostException).
     */
    fun isReactNative(error: Throwable): Boolean {
      var e: Throwable? = error
      var depth = 0
      while (e != null && depth < 8) {
        if (e.stackTrace.any { it.className.startsWith("com.facebook.react.") }) return true
        e = e.cause
        depth++
      }
      return false
    }
  }
}

/**
 * The root's initial props as a Bundle (native-bridge.md §8.1), the shape React Native's
 * `Arguments.fromBundle` reads: objects as nested Bundles, arrays as lists, every number as a
 * Double, null as a null String.
 */
internal object PulseKitProps {
  /** [fields] as a Bundle. */
  fun bundle(fields: Map<String, PulseJson>): Bundle {
    val b = Bundle()
    for ((key, value) in fields) {
      when (value) {
        PulseJson.Null -> b.putString(key, null)
        is PulseJson.Bool -> b.putBoolean(key, value.value)
        is PulseJson.Integer -> b.putDouble(key, value.value.toDouble())
        is PulseJson.Num -> b.putDouble(key, value.value)
        is PulseJson.Str -> b.putString(key, value.value)
        is PulseJson.Obj -> b.putBundle(key, bundle(value.fields))
        is PulseJson.Arr -> b.putSerializable(key, list(value.items))
      }
    }
    return b
  }

  private fun list(items: List<PulseJson>): ArrayList<Any?> = items.mapTo(ArrayList()) { item(it) }

  private fun item(value: PulseJson): Any? = when (value) {
    PulseJson.Null -> null
    is PulseJson.Bool -> value.value
    is PulseJson.Integer -> value.value.toDouble()
    is PulseJson.Num -> value.value
    is PulseJson.Str -> value.value
    is PulseJson.Obj -> bundle(value.fields)
    is PulseJson.Arr -> list(value.items)
  }
}
