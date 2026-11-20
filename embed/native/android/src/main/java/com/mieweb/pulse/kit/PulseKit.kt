// Mirrors embed/native/ios/PulseKit.swift: the PulseKit facade (native-bridge.md §8, §9). The
// runtime half (Pulse JS's messages, forwarded writes, host requests, memory pressure, fatal
// errors) is PulseKitRuntime.kt; the pure rules are core/ (vector-checked on the JVM).

package com.mieweb.pulse.kit

import android.app.Activity
import android.app.Application
import android.content.ActivityNotFoundException
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.res.Configuration
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.mieweb.pulse.kit.core.OpenDecision
import com.mieweb.pulse.kit.core.PresenterState
import com.mieweb.pulse.kit.core.PulseBusy
import com.mieweb.pulse.kit.core.PulseCatalogReader
import com.mieweb.pulse.kit.core.PulseChecked
import com.mieweb.pulse.kit.core.PulseContract
import com.mieweb.pulse.kit.core.PulseError
import com.mieweb.pulse.kit.core.PulseEvent
import com.mieweb.pulse.kit.core.PulseJson
import com.mieweb.pulse.kit.core.PulseNetworkView
import com.mieweb.pulse.kit.core.PulseRequest
import com.mieweb.pulse.kit.core.PulseRoute
import com.mieweb.pulse.kit.core.PulseRouter
import com.mieweb.pulse.kit.core.PulseValidation
import com.mieweb.pulse.kit.core.PulseReply as ReplyEnvelope
import java.io.IOException
import java.lang.ref.WeakReference
import java.util.UUID

/** PulseKit's one log line writer (logcat tag `PulseKit`). Never pass it a token or a header. */
internal fun pulseKitLog(line: String) {
  Log.i(PulseKit.TAG, line)
}

/**
 * Pulse inside another app (native-bridge.md §8, §9). Hosts and their Capacitor or Cordova plugin
 * talk to this one class through one JSON transport: a request envelope in, exactly one reply
 * envelope out, plus event envelopes through the [PulseEventListener]. A new method therefore
 * needs no plugin change unless the facade itself must answer it. The same envelopes, methods,
 * error codes and capabilities as the Swift facade.
 *
 * - Answered here, natively: contract minor 0 (info, configure, prewarm, open, close, isOpen,
 *   pendingResults, acknowledge, logFile) and minor 1's account and read methods (setAccount,
 *   listDrafts, getDraft, countDrafts, usage, listNamespaces, purge), and respondHostRequest.
 * - Forwarded to Pulse JS (§3 "JS"): the host's writes, each as one `pulse.cmd` answered by one
 *   `pulse.reply` within 30 s (or the client's `timeoutMs`), a cold boot included
 *   (PulseKitRuntime.kt). A cold runtime boots under "Preparing…"; with no Activity in front the
 *   write answers `runtime.paused` (Android has no headless boot yet).
 * - Host requests (§5): Pulse JS's `hostRequest` events reach the listener (kept while none is
 *   set, as `flowResult` events are: the Capacitor plugin instance can be recreated with the
 *   host Activity).
 * - Lifetime (C6): the runtime stays up between flows; on memory pressure with nothing open,
 *   Pulse JS decides whether it is idle and, if so, PulseKit releases the instance.
 * - Accounts (PulseKitAccounts.kt): each signed-in person has a namespace, under
 *   `filesDir/PulseKit/<ns>` and `cacheDir/PulseKit/<ns>` (PulseKitStorage.kt). Until
 *   `setAccount`, data calls and `open` fail with `no_account`.
 * - Reads come from catalog.json without starting Pulse's runtime.
 * - One flow at a time: the camera and the audio focus belong to the whole process.
 * - The facade never opens SQLite; it reads only the files Pulse JS writes.
 *
 * Threads: [call] and [setEventListener] may be called from any thread and hop to the main
 * thread; every reply and event is delivered on the main thread. `shared` keeps only the
 * application context.
 */
class PulseKit private constructor(context: Context) {
  /** The application context; PulseKit never keeps an Activity past a call. */
  internal val app: Context = context.applicationContext ?: context
  internal val application: Application? get() = app as? Application

  private val main = Handler(Looper.getMainLooper())
  internal val storage = PulseKitStorage(app)
  internal val accounts = PulseKitAccounts(storage)
  internal val network = PulseKitNetwork(app)
  internal val runtime = PulseKitRuntime(this)

  /** Pulse's screens (PR4-D). */
  internal val presenter: PresenterPort = PulseKitPresenter

  private var config: Map<String, PulseJson> = emptyMap()

  /** The open flow: one request, presented once, ended by exactly one result. */
  internal var flow: PulseKitFlow? = null
    private set

  /** A purge waiting for Pulse JS to let go of the library: open, setAccount and purge are busy. */
  internal var purging: String? = null
    private set

  private var listener: PulseEventListener? = null

  /** An event that came while no listener was set. */
  private class Retained(val hostCallId: String?, val name: String, val text: String)

  /**
   * `hostRequest` events (until each one's deadline) and `flowResult` events that came while no
   * listener was set, in order; delivered to the next one.
   */
  private val retainedEvents = mutableListOf<Retained>()

  /**
   * The open reply each recent flow ended with, by requestId, so PulseActivity can put it in its
   * Activity result (`RESULT_EXTRA_JSON`) after the facade ended the flow.
   */
  private val endedReplies = object : LinkedHashMap<String, String>() {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean =
      size > ENDED_REPLIES_KEPT
  }

  /** The app's resumed Activity (lifecycle callbacks), for "Preparing…". */
  private var resumed: WeakReference<Activity>? = null

  /** The FlowPort PulseActivity and the presenter call (PulseKitSeams.kt). */
  internal val flows: FlowPort = object : FlowPort {
    override fun onShown(requestId: String) = onMain { shown(requestId) }

    override fun onViewGone(requestId: String, reason: String) =
      onMain { viewGone(requestId, reason) }

    override fun onRecreatedWithoutFlow(requestId: String, requestJson: String?) =
      onMain { recreatedWithoutFlow(requestId, requestJson) }

    override fun onFatal(error: Throwable) = onMain { runtime.onFatal(error) }
  }

  private var started = false

  /**
   * Everything PulseKit follows for the process's life, registered once on the main thread:
   * the network callback, the Activity lifecycle (for "Preparing…"), memory pressure, Pulse JS's
   * messages and the background uploads. [shared] runs it right after the instance is published,
   * so anything it starts that asks for [shared] gets this instance.
   */
  private fun start() {
    if (started) return
    started = true
    network.onChange = { old, new -> networkChanged(old, new) }
    network.start()
    val lifecycle = object : Application.ActivityLifecycleCallbacks {
      override fun onActivityResumed(activity: Activity) {
        resumed = WeakReference(activity)
      }

      override fun onActivityPaused(activity: Activity) {
        if (resumed?.get() === activity) resumed = null
      }

      override fun onActivityDestroyed(activity: Activity) {
        if (resumed?.get() === activity) resumed = null
      }

      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

      override fun onActivityStarted(activity: Activity) = Unit

      override fun onActivityStopped(activity: Activity) = Unit

      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    }
    application?.registerActivityLifecycleCallbacks(lifecycle)
    app.registerComponentCallbacks(object : ComponentCallbacks2 {
      override fun onTrimMemory(level: Int) = trimMemory(level)

      override fun onConfigurationChanged(newConfig: Configuration) = Unit

      @Deprecated("Deprecated in Java")
      @Suppress("DEPRECATION")
      override fun onLowMemory() = trimMemory(ComponentCallbacks2.TRIM_MEMORY_COMPLETE)
    })
    runtime.listen()
    // Background uploads (PR4-E): their listener from the first `shared` access, with no UI or
    // React Native, so Pulse JS's first upload message is heard.
    PulseKitUploads.start(app)
  }

  // Transport

  /** [call] without a launcher: PulseKit starts PulseActivity itself. */
  fun call(activity: Activity?, requestJson: String, reply: PulseReply) {
    call(activity, requestJson, null, reply)
  }

  /**
   * The whole transport: one request envelope in, one reply envelope out, on the main thread.
   * [activity] is the host Activity `open` starts Pulse over (other methods use it only to show
   * "Preparing…"); [launcher] starts PulseActivity for a host that owns the launch (the Capacitor
   * plugin's Activity-result bridge). `open` replies when the flow ends.
   */
  fun call(
    activity: Activity?,
    requestJson: String,
    launcher: PulseOpenLauncher?,
    reply: PulseReply,
  ) {
    val ref = activity?.let { WeakReference(it) }
    onMain { handle(requestJson, ref?.get(), launcher, reply) }
  }

  /**
   * The one event subscriber (on the main thread); null removes it. Events that came while none
   * was set (host requests still in time, flow results) are delivered to it at once.
   */
  fun setEventListener(listener: PulseEventListener?) {
    onMain {
      this.listener = listener
      deliverRetainedEvents()
    }
  }

  private fun handle(
    text: String,
    activity: Activity?,
    launcher: PulseOpenLauncher?,
    reply: PulseReply,
  ) {
    val respond = { r: ReplyEnvelope -> reply.onReply(r.serialized) }
    val route = PulseRouter.route(
      text,
      supported = PulseKitInfo.support(app).supported,
      methods = methods,
      forwarded = forwardedMethods,
    )
    when (route) {
      is PulseRoute.Reply -> {
        log("call ${route.reply.callId}: ${route.error?.code ?: "ok"}")
        respond(route.reply)
      }
      is PulseRoute.Forward ->
        runtime.forward(route.request, PulseKitRuntime.timeoutMs(text), activity) {
          reply.onReply(it)
        }
      is PulseRoute.Native -> answer(route.request, activity, launcher, respond)
    }
  }

  private fun answer(
    req: PulseRequest,
    activity: Activity?,
    launcher: PulseOpenLauncher?,
    respond: (ReplyEnvelope) -> Unit,
  ) {
    val callId = req.callId
    when (req.method) {
      "info" -> respond(ReplyEnvelope.success(callId, PulseKitInfo.json(app, accounts.namespace)))
      "configure" -> {
        val invalid = PulseValidation.configure(req.args, callId)
        if (invalid != null) return respond(ReplyEnvelope.failure(invalid))
        config = req.args
        // A runtime that is up reads the host's options per command (uploadMode for upload and
        // retireDraft), so it hears each change; one booting hears them on `pulse.ready`.
        if (runtime.jsReady) {
          runtime.sendCommand(
            "configure",
            PulseJson.Obj(effectiveConfig(callId, quiet = true)),
            expectReply = false,
          )
        }
        respond(ReplyEnvelope.success(callId))
      }
      "prewarm" -> {
        if (runtime.startRuntime()) {
          respond(ReplyEnvelope.success(callId))
        } else {
          respond(ReplyEnvelope.failure("runtime.error", "Pulse couldn't start.", callId))
        }
      }
      "open" -> {
        val ref = activity?.let { WeakReference(it) }
        // Pulse JS may be letting go of its library (lifetime.ts): the flow waits for the answer
        // (10 s at most), then mounts on this runtime or a fresh one.
        val deferred = runtime.deferOpen { open(req, ref?.get(), launcher, respond) }
        if (deferred) {
          log("open $callId: waits for the memory check")
        } else {
          open(req, activity, launcher, respond)
        }
      }
      "close" -> close(req, respond)
      "isOpen" -> respond(ReplyEnvelope.success(callId, PulseJson.Bool(flow != null)))
      "pendingResults" -> withRoots(callId, respond) { PulseJson.Arr(it.inbox.pending()) }
      "acknowledge" -> {
        val requestId = req.args["requestId"]?.string
        if (requestId == null || !PulseValidation.isPlainName(requestId)) {
          return respond(
            ReplyEnvelope.failure("invalid_options", "acknowledge needs a requestId.", callId),
          )
        }
        // Signed out there is no inbox to delete from: like an unknown id, a no-op.
        if (accounts.namespace == null) return respond(ReplyEnvelope.success(callId))
        withRoots(callId, respond) { roots ->
          roots.inbox.acknowledge(requestId)
          PulseJson.Null
        }
      }
      "logFile" -> logFile(callId, respond)
      "setAccount" -> setAccount(req, respond)
      "listDrafts" -> when (val f = PulseCatalogReader.Filter.from(req.args)) {
        is PulseCatalogReader.Parsed.Problem ->
          respond(ReplyEnvelope.failure("invalid_options", f.problem.message, callId))
        is PulseCatalogReader.Parsed.Ok -> withCatalog(callId, respond) { catalog, net ->
          PulseJson.Arr(
            PulseCatalogReader.listDrafts(catalog, f.value, net).map { PulseJson.Obj(it) },
          )
        }
      }
      "getDraft" -> {
        val id = req.args["id"]?.string
        if (id.isNullOrEmpty()) {
          return respond(ReplyEnvelope.failure("invalid_options", "getDraft needs an id.", callId))
        }
        withCatalog(callId, respond) { catalog, net ->
          PulseCatalogReader.getDraft(catalog, id, net)?.let { PulseJson.Obj(it) } ?: PulseJson.Null
        }
      }
      "countDrafts" -> when (val o = PulseCatalogReader.CountOptions.from(req.args)) {
        is PulseCatalogReader.Parsed.Problem ->
          respond(ReplyEnvelope.failure("invalid_options", o.problem.message, callId))
        is PulseCatalogReader.Parsed.Ok -> withCatalog(callId, respond) { catalog, net ->
          val out = LinkedHashMap<String, PulseJson>()
          for ((group, count) in PulseCatalogReader.countDrafts(catalog, o.value, net)) {
            out[group] = PulseJson.Integer(count.toLong())
          }
          PulseJson.Obj(out)
        }
      }
      "usage" -> withCatalog(callId, respond) { catalog, net ->
        val c = PulseCatalogReader.counts(catalog, net)
        val ns = accounts.namespace ?: ""
        PulseJson.obj(
          "namespace" to PulseJson.Str(ns),
          "bytes" to PulseJson.Integer(storage.bytes(ns)),
          "drafts" to PulseJson.Integer(c.drafts.toLong()),
          "unsent" to PulseJson.Integer(c.unsent.toLong()),
          "uploading" to PulseJson.Integer(c.uploading.toLong()),
          "failed" to PulseJson.Integer(c.failed.toLong()),
          "receipts" to PulseJson.Integer(c.receipts.toLong()),
        )
      }
      "listNamespaces" ->
        respond(ReplyEnvelope.success(callId, PulseJson.Arr(accounts.list(netView))))
      "purge" -> purge(req, respond)
      "respondHostRequest" -> runtime.respondHostRequest(req, respond)
      else -> respond(
        ReplyEnvelope.failure(
          "method.unsupported",
          "This PulseKit doesn't answer ${req.method}.",
          callId,
        ),
      )
    }
  }

  /**
   * `logFile`: §3 lists no errors for it (minor 0), so never `no_account`. The log is the one the
   * runtime writes (its namespace, even while restart_required lets reads answer for another
   * account), else the active account's; with neither, there is no log.
   */
  private fun logFile(callId: String, respond: (ReplyEnvelope) -> Unit) {
    if (config["policy"]?.get("logs")?.string == "off") {
      return respond(ReplyEnvelope.failure("not_found", "Logs are off (policy.logs).", callId))
    }
    val ns = runtime.runtimeNamespace ?: accounts.namespace
      ?: return respond(
        ReplyEnvelope.failure("not_found", "There is no log yet (no account).", callId),
      )
    try {
      val file = storage.roots(ns).logFile
      file.parentFile?.let { PulseKitStorage.makeDirs(it) }
      respond(
        ReplyEnvelope.success(
          callId,
          PulseJson.obj(
            "rel" to PulseJson.Str("logs/pulse.log"),
            "path" to PulseJson.Str(file.path),
            "webUrl" to PulseJson.Str(""),
            "bytes" to PulseJson.Integer(if (file.isFile) file.length() else 0L),
          ),
        ),
      )
    } catch (e: IOException) {
      respond(
        ReplyEnvelope.failure("unknown", "Pulse's folders aren't available: ${e.message}", callId),
      )
    }
  }

  /** The hostId namespaces start with: configure's, or the sanitised package name. */
  private val hostId: String
    get() = config["hostId"]?.string ?: PulseKitInfo.defaultHostId(app)

  /** The active account's roots, or `no_account`. */
  private fun withRoots(
    callId: String,
    respond: (ReplyEnvelope) -> Unit,
    body: (PulseKitRoots) -> PulseJson,
  ) {
    val roots = try {
      accounts.activeRoots() ?: return respond(noAccount(callId))
    } catch (e: IOException) {
      return respond(
        ReplyEnvelope.failure("unknown", "Pulse's folders aren't available: ${e.message}", callId),
      )
    }
    respond(ReplyEnvelope.success(callId, body(roots)))
  }

  /**
   * The active account's catalog (an empty one when there is none yet, or it can't be read) and
   * the network as the host should see it. A `readOnly` catalog (a newer schema) is read like any
   * other: such a library still lists, sends and deletes.
   */
  private fun withCatalog(
    callId: String,
    respond: (ReplyEnvelope) -> Unit,
    body: (PulseCatalogReader.Catalog, PulseNetworkView) -> PulseJson,
  ) {
    val net = netView
    withRoots(callId, respond) { roots ->
      // FileRef paths are rebuilt from `rel` under today's root (a restore can move it, and
      // catalog.json keeps the old paths until Pulse JS boots).
      val catalog = PulseKitStorage.readCatalog(roots.documents) ?: PulseCatalogReader.Catalog.EMPTY
      body(catalog.rebased(roots.documents.path), net)
    }
  }

  internal fun noAccount(callId: String, requestId: String? = null): ReplyEnvelope =
    ReplyEnvelope.failure("no_account", "No account is set (setAccount).", callId, requestId)

  private fun namespaceResult(ns: String): PulseJson =
    PulseJson.obj("namespace" to PulseJson.Str(ns))

  // Accounts (§4)

  private fun setAccount(req: PulseRequest, respond: (ReplyEnvelope) -> Unit) {
    val callId = req.callId
    val outcome = accounts.set(
      req.args,
      hostId = hostId,
      flowOpen = flow != null || purging != null,
      bound = runtime.boundNamespace,
      callId = callId,
    )
    when (outcome) {
      is AccountOutcome.Failed -> {
        log("setAccount $callId: ${outcome.error.code}")
        respond(ReplyEnvelope.failure(outcome.error))
      }
      AccountOutcome.Cleared -> {
        log("setAccount $callId: signed out")
        notifyAccountActive()
        respond(ReplyEnvelope.success(callId, PulseJson.obj("namespace" to PulseJson.Null)))
      }
      is AccountOutcome.Unchanged -> {
        notifyAccountActive()
        respond(ReplyEnvelope.success(callId, namespaceResult(outcome.namespace)))
      }
      is AccountOutcome.Switched -> {
        log("setAccount $callId: now ${outcome.namespace}")
        removeEmptyLocalNamespaces()
        notifyAccountActive()
        respond(ReplyEnvelope.success(callId, namespaceResult(outcome.namespace)))
      }
      is AccountOutcome.RestartRequired -> {
        notifyAccountActive()
        // §4: reads now answer for the new account; open waits for a restart.
        log("setAccount $callId: now ${outcome.namespace} for reads; restart_required for Pulse")
        removeEmptyLocalNamespaces()
        respond(
          ReplyEnvelope.failure(
            PulseError.of(
              "restart_required",
              "Pulse already opened another account's library in this process; reads answer " +
                "for the new account, and Pulse opens for it after the app restarts.",
              callId,
              details = PulseJson.obj("namespace" to PulseJson.Str(outcome.namespace)),
            ),
          ),
        )
      }
    }
  }

  /**
   * The job loop runs only while its runtime's namespace is the signed-in account's: after every
   * setAccount, Pulse JS hears whether it still is (`pulse.cmd accountActive`). A signed-out or
   * switched account pauses its uploads; signing back in resumes them.
   */
  private fun notifyAccountActive() {
    val bound = runtime.runtimeNamespace ?: return
    if (!runtime.jsReady) return
    val active = accounts.namespace == bound
    log("account ${if (active) "active" else "inactive"} for Pulse JS in $bound")
    runtime.sendCommand(
      "accountActive",
      PulseJson.obj("active" to PulseJson.Bool(active)),
      expectReply = false,
    )
  }

  private fun removeEmptyLocalNamespaces() {
    val bound = runtime.runtimeNamespace
    for (removed in PulseKitAccounts.removeEmptyLocalNamespaces(storage, bound)) {
      log("removed the empty PR1 namespace $removed")
    }
  }

  /**
   * `purge({namespace?})`: delete a namespace's drafts, receipts, jobs and files (default: the
   * active one). If Pulse JS has that library open, it lets go first (`releaseLibrary`); the
   * folders go only after it says so. The shared models go when no namespace is left. The account
   * stays signed in: the next call recreates empty folders.
   */
  private fun purge(req: PulseRequest, respond: (ReplyEnvelope) -> Unit) {
    val callId = req.callId
    if (flow != null || purging != null) {
      return respond(ReplyEnvelope.failure("busy", "Pulse is open; purge after it closes.", callId))
    }
    if (runtime.hasForwarded || runtime.preparingId != null || runtime.memoryCheck != null) {
      return respond(
        ReplyEnvelope.failure("busy", "Pulse is answering another call; purge after it.", callId),
      )
    }
    val ns = when (val n = req.args["namespace"]) {
      null, PulseJson.Null -> accounts.namespace ?: return respond(noAccount(callId))
      is PulseJson.Str -> {
        if (!PulseKitStorage.isNamespaceName(n.value)) {
          return respond(
            ReplyEnvelope.failure("invalid_options", "${n.value} isn't a namespace.", callId),
          )
        }
        n.value
      }
      else -> return respond(
        ReplyEnvelope.failure("invalid_options", "namespace must be a string.", callId),
      )
    }
    val wasActive = ns == accounts.namespace
    // The rows that go, for the active namespace's draftsChanged.
    val catalog = if (wasActive) PulseKitStorage.readCatalog(storage.documents(ns)) else null
    val ids: List<PulseJson> = catalog?.let { c ->
      (c.drafts + c.receipts).mapNotNull { row -> row["id"]?.string?.let { PulseJson.Str(it) } }
    } ?: emptyList()
    val remove = {
      try {
        storage.remove(ns)
        log("purge $callId: removed $ns")
        respond(ReplyEnvelope.success(callId))
        if (wasActive) {
          emit(
            "draftsChanged",
            PulseJson.obj("namespace" to PulseJson.Str(ns), "ids" to PulseJson.Arr(ids)),
          )
        }
      } catch (e: IOException) {
        respond(ReplyEnvelope.failure("unknown", "Pulse couldn't delete $ns: ${e.message}", callId))
      }
    }
    if (ns != runtime.boundNamespace) return remove()

    // Pulse JS has this library open: it closes the database and stops its job loop first.
    purging = ns
    var answered = false
    val commandId = runtime.sendCommand(
      "releaseLibrary",
      PulseJson.obj("namespace" to PulseJson.Str(ns)),
      flowScoped = false,
    ) { reply ->
      if (answered) return@sendCommand
      answered = true
      purging = null
      if (reply["ok"]?.bool == true) {
        // That runtime's database is closed for good (§4: fixed per runtime): no namespace is
        // bound any more (so a restart_required for another account is lifted), and the next use
        // starts a fresh instance, which opens the library afresh.
        runtime.dropBinding()
        log("purge $callId: Pulse let go of $ns; the next use starts a fresh runtime")
        remove()
      } else {
        log("purge $callId: releaseLibrary failed: ${reply["error"]?.get("code")?.string ?: "?"}")
        respond(
          ReplyEnvelope.failure(
            "unknown",
            "Pulse couldn't close the library; nothing was deleted.",
            callId,
          ),
        )
      }
    }
    after(PURGE_TIMEOUT_MS) {
      if (answered) return@after
      answered = true
      runtime.dropCommand(commandId)
      purging = null
      // Pulse JS may still close its library after this: never send that runtime another command.
      // The next call starts a fresh one; nothing was deleted.
      runtime.dropBinding()
      log("purge $callId: Pulse didn't let go of $ns in ${PURGE_TIMEOUT_MS / 1000} s; dropped")
      respond(
        ReplyEnvelope.failure(
          "timeout",
          "Pulse didn't close the library in time; nothing was deleted.",
          callId,
        ),
      )
    }
  }

  // Reachability (Q6: PulseKit is the only source)

  /** The network as the catalog reader sees it, with the host's Wi-Fi-only choice. */
  private val netView: PulseNetworkView
    get() {
      val s = network.state
      return PulseNetworkView(
        online = s.online,
        wifi = s.wifi,
        wifiOnlyUploads = config["policy"]?.get("wifiOnlyUploads")?.bool ?: false,
      )
    }

  /**
   * Every change goes to Pulse JS as `pulse.cmd network` (src/core/network.ts), so Kotlin and JS
   * derive `waiting_network` from the same values. When a queued draft's shown state flips, the
   * host hears `draftsChanged` for those drafts.
   */
  private fun networkChanged(old: PulseKitNetwork.State, new: PulseKitNetwork.State) {
    if (runtime.runtimeNamespace != null) {
      runtime.sendCommand("network", new.json, expectReply = false)
    }
    val wifiOnly = netView.wifiOnlyUploads
    val before = PulseNetworkView(old.online, old.wifi, wifiOnly)
    if (PulseCatalogReader.shownState("queued", before) ==
      PulseCatalogReader.shownState("queued", netView)
    ) {
      return
    }
    val ns = accounts.namespace ?: return
    val catalog = PulseKitStorage.readCatalog(storage.documents(ns)) ?: return
    val ids = catalog.drafts.filter { it["state"]?.string == "queued" }
      .mapNotNull { it["id"]?.string }
    if (ids.isEmpty()) return
    emit(
      "draftsChanged",
      PulseJson.obj(
        "namespace" to PulseJson.Str(ns),
        "ids" to PulseJson.Arr(ids.map { PulseJson.Str(it) }),
      ),
    )
  }

  // Lifetime (C6)

  /**
   * Memory pressure: TRIM_MEMORY_RUNNING_LOW and RUNNING_CRITICAL (the app is running and memory
   * is short), TRIM_MEMORY_BACKGROUND and above (the app is cached and next in line to be killed),
   * and onLowMemory. TRIM_MEMORY_UI_HIDDEN alone is not pressure: it comes every time the app
   * leaves the screen. Android 14+ delivers only UI_HIDDEN and BACKGROUND. The runtime asks Pulse
   * JS only while nothing is open (never released under a flow).
   */
  private fun trimMemory(level: Int) {
    @Suppress("DEPRECATION")
    val running = level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW &&
      level < ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN
    if (!running && level < ComponentCallbacks2.TRIM_MEMORY_BACKGROUND) return
    onMain {
      log("onTrimMemory $level")
      runtime.memoryWarning()
    }
  }

  // Flows

  private fun open(
    req: PulseRequest,
    activity: Activity?,
    launcher: PulseOpenLauncher?,
    respond: (ReplyEnvelope) -> Unit,
  ) {
    val callId = req.callId
    val args = when (val checked = PulseValidation.open(req.args, callId)) {
      is PulseChecked.Invalid -> return respond(ReplyEnvelope.failure(checked.error))
      is PulseChecked.Ok -> checked.value
    }
    val state = if (activity != null) presenter.state(activity) else PresenterState.NONE
    val open = flow
    if (open == null) {
      // A flow writes into the active account's library: none, or a purge under way, stops it.
      if (purging != null) {
        return respond(
          ReplyEnvelope.failure("busy", "Pulse is deleting a library.", callId, args.requestId),
        )
      }
      val ns = accounts.namespace ?: return respond(noAccount(callId, args.requestId))
      val bound = runtime.boundNamespace
      if (bound != null && bound != ns) {
        return respond(
          ReplyEnvelope.failure(
            "restart_required",
            "Pulse has another account's library open; restart the app.",
            callId,
            args.requestId,
          ),
        )
      }
    }
    // requestId idempotency outlives the flow: while its result sits unacknowledged in the inbox,
    // the same requestId gets that result back. Presenting again would answer the new flow with
    // the old file, and the new flow's result would replace one the host hasn't seen (AD15).
    val stored: PulseJson? = if (open == null && args.requestId != null) {
      try {
        accounts.activeRoots()?.inbox?.read(args.requestId)
      } catch (e: IOException) {
        null
      }
    } else {
      null
    }
    val decision = PulseBusy.decideOpen(open?.requestId, args.requestId, state, stored != null)
    if (decision == OpenDecision.DELIVERED && stored != null) {
      log("open $callId: ${args.requestId} already ended; answering from the inbox")
      return respond(ReplyEnvelope.success(callId, stored))
    }
    if (decision == OpenDecision.JOIN && open != null) {
      log("open $callId: joins ${open.requestId}")
      open.waiters.add(callId to respond)
      return
    }
    if (decision == OpenDecision.BUSY) {
      return respond(
        ReplyEnvelope.failure(
          "busy",
          "Pulse is already open, or the app is showing another screen.",
          callId,
          args.requestId,
        ),
      )
    }
    if (decision != OpenDecision.START || activity == null) {
      return respond(
        ReplyEnvelope.failure(
          "host_misconfigured",
          "open needs the Activity to start Pulse from.",
          callId,
        ),
      )
    }

    val missing = PulseKitInfo.missingRequiredPermissions(app)
    if (missing.isNotEmpty()) {
      return respond(
        ReplyEnvelope.failure(
          PulseError.of(
            "host_misconfigured",
            "The app's manifest lacks ${missing.joinToString(", ")}.",
            callId,
            args.requestId,
            details = PulseJson.obj("missing" to PulseJson.Arr(missing.map { PulseJson.Str(it) })),
          ),
        ),
      )
    }
    val roots = try {
      val active = accounts.activeRoots() ?: return respond(noAccount(callId, args.requestId))
      try {
        accounts.touch()
      } catch (e: IOException) {
        log("open $callId: couldn't record the account's use: ${e.message}")
      }
      active
    } catch (e: IOException) {
      return respond(
        ReplyEnvelope.failure("unknown", "Pulse's folders aren't available: ${e.message}", callId),
      )
    }
    if (!runtime.startRuntime()) {
      return respond(
        ReplyEnvelope.failure("runtime.error", "Pulse couldn't start.", callId, args.requestId),
      )
    }

    val requestId = args.requestId ?: UUID.randomUUID().toString().lowercase()
    val request = LinkedHashMap(args.request)
    request["requestId"] = PulseJson.Str(requestId)
    // The root component's initial props (§8.1).
    val props = LinkedHashMap<String, PulseJson>()
    props["requestId"] = PulseJson.Str(requestId)
    props["request"] = PulseJson.Obj(request)
    props["documentsDir"] = PulseJson.Str(roots.documents.path)
    props["cachesDir"] = PulseJson.Str(roots.caches.path)
    props["modelsDir"] = PulseJson.Str(roots.models.path)
    props["namespace"] = PulseJson.Str(roots.namespace)
    props["config"] = PulseJson.Obj(effectiveConfig(callId))
    props["headless"] = PulseJson.Bool(false)
    // Reachability (Q6): PulseKitNetwork is Pulse JS's only source; changes follow as
    // `pulse.cmd network`.
    props["network"] = network.state.json
    // What a PulseActivity restored after process death reports (onRecreatedWithoutFlow): the
    // open envelope with its requestId, plus the namespace whose inbox gets the fallback result.
    val requestJson = PulseJson.obj(
      "v" to PulseJson.Integer(PulseContract.ENVELOPE_VERSION.toLong()),
      "callId" to PulseJson.Str(callId),
      "method" to PulseJson.Str("open"),
      "args" to PulseJson.Obj(request),
      "namespace" to PulseJson.Str(roots.namespace),
    ).serialized

    val next = PulseKitFlow(requestId, callId, request, roots)
    next.waiters.add(callId to respond)
    flow = next
    runtime.bind(roots.namespace)
    log("open $callId: ${args.entry} as $requestId in ${roots.namespace}")
    try {
      presenter.launch(
        activity,
        launcher,
        FlowLaunch(requestId, "flow", requestJson, PulseKitProps.bundle(props)),
      )
    } catch (e: RuntimeException) {
      // ActivityNotFoundException: the merged manifest lost PulseActivity.
      flow = null
      log("open $callId: Pulse's screen couldn't start (${e.javaClass.simpleName})")
      val code = if (e is ActivityNotFoundException) "host_misconfigured" else "runtime.error"
      respond(
        ReplyEnvelope.failure(code, "Pulse's screen couldn't start.", callId, requestId),
      )
    }
  }

  /**
   * The host's options as Pulse JS gets them, with what the host's build rules out: no Save to
   * Photos where it can't work (Android 7–9 without WRITE_EXTERNAL_STORAGE in the merged
   * manifest), whatever the policy says (AD30).
   */
  internal fun effectiveConfig(callId: String, quiet: Boolean = false): Map<String, PulseJson> {
    if (PulseKitInfo.canSaveToPhotos(app)) return config
    val out = LinkedHashMap(config)
    val policy = LinkedHashMap(config["policy"]?.obj ?: emptyMap())
    policy["allowSaveToPhotos"] = PulseJson.Bool(false)
    out["policy"] = PulseJson.Obj(policy)
    if (!quiet) {
      log(
        "$callId: host_misconfigured: no WRITE_EXTERNAL_STORAGE below Android 10, " +
          "Save to Photos is hidden",
      )
    }
    return out
  }

  /**
   * `close`: ask Pulse JS to end the flow (it writes the result, as for X), and dismiss anyway
   * after 5 s if it doesn't.
   */
  private fun close(req: PulseRequest, respond: (ReplyEnvelope) -> Unit) {
    val open = flow ?: return respond(ReplyEnvelope.success(req.callId))
    val args = LinkedHashMap(req.args)
    if (args["reason"] == null) args["reason"] = PulseJson.Str("host")
    runtime.sendCommand("close", PulseJson.Obj(args))
    if (open.forceClose == null) {
      open.forceClose = after(FORCE_CLOSE_MS) {
        if (flow !== open) return@after
        log("close: Pulse didn't end ${open.requestId} in ${FORCE_CLOSE_MS / 1000} s; dismissing")
        finish(open.roots.inbox.read(open.requestId) ?: interrupted(open, "host"))
      }
    }
    respond(ReplyEnvelope.success(req.callId))
  }

  /**
   * End the open flow with [result]: make sure the inbox has it (written before any event),
   * dismiss, then resolve every waiting `open` and emit `flowResult`.
   */
  internal fun finish(result: PulseJson) {
    val ending = flow ?: return
    flow = null
    ending.forceClose?.let { cancel(it) }
    for (id in ending.commandIds) {
      if (runtime.dropCommand(id)) {
        log("pulse.cmd $id: no reply before ${ending.requestId} ended; dropped")
      }
    }
    ending.roots.inbox.writeIfAbsent(result, ending.requestId)
    log("open ${ending.callId}: ended ${result["status"]?.string ?: "?"} for ${ending.requestId}")
    endedReplies[ending.requestId] = ReplyEnvelope.success(ending.callId, result).serialized
    presenter.dismiss(ending.requestId)
    for ((waiterCallId, reply) in ending.waiters) reply(ReplyEnvelope.success(waiterCallId, result))
    emit("flowResult", result)
  }

  /** The facade's own result for a flow Pulse JS didn't end (PulseKitResults.interrupted). */
  private fun interrupted(flow: PulseKitFlow, reason: String): PulseJson =
    PulseKitResults.interrupted(flow.request, flow.requestId, flow.hasTake, reason)

  /** `failed{runtime.error}` for [flow]. */
  internal fun failed(flow: PulseKitFlow, message: String): PulseJson =
    PulseKitResults.failed(flow.request, flow.requestId, flow.callId, message)

  /** `pulse.result`: the result file for [requestId] is written; end that flow with it. */
  internal fun onResultMessage(requestId: String, runtimeNamespace: String?) {
    val open = flow
    if (open != null && open.requestId == requestId) {
      finish(
        open.roots.inbox.read(requestId) ?: PulseKitResults.failed(
          open.request,
          requestId,
          open.callId,
          "Pulse finished but its result is missing.",
          code = "unknown",
        ),
      )
      return
    }
    // A flow the facade already ended (a forced close, its screen gone): the inbox has Pulse's own
    // result now, and the host hears it as a second flowResult.
    val ns = runtimeNamespace ?: return
    val result = try {
      storage.roots(ns).inbox.read(requestId)
    } catch (e: IOException) {
      null
    } ?: return
    emit("flowResult", result)
  }

  /** `pulse.ui`: the screen settings for the open flow; dropped while none is open (§8.1). */
  internal fun applyUi(message: PulseJson) {
    val open = flow ?: return
    val hasTake = message["hasTake"]?.bool
    if (hasTake != null) open.hasTake = hasTake
    val statusBar = message["statusBar"]?.string
    presenter.applyUi(UiState(statusBar, message["statusBarHidden"]?.bool, hasTake))
  }

  private fun shown(requestId: String) {
    val open = flow
    if (open != null && open.requestId == requestId) {
      open.shown = true
      log("open ${open.callId}: $requestId is on screen")
    }
  }

  /**
   * A flow's screen went away without Pulse JS or the facade closing it (PulseActivity finished
   * by a singleTask relaunch of the host, or destroyed by the system): if no `pulse.result` came,
   * the fallback result with reason `interrupted` answers the open. The take Pulse JS already
   * saved stays a draft.
   */
  private fun viewGone(requestId: String, reason: String) {
    if (requestId == runtime.preparingId) return runtime.preparingGone(requestId)
    val open = flow ?: return
    if (open.requestId != requestId) return
    log("open ${open.callId}: Pulse's screen went away ($reason)")
    finish(open.roots.inbox.read(requestId) ?: interrupted(open, "interrupted"))
  }

  /**
   * PulseActivity came back with no flow to resume (process death, or a restored task): write the
   * fallback result `canceled` (or `closed` when the request named a draft, whose take Pulse JS
   * saved) with reason `interrupted`, unless the inbox already has one, emit `flowResult`, and keep
   * the reply for the Activity result ([endedReply]). PulseActivity then finishes.
   */
  private fun recreatedWithoutFlow(requestId: String, requestJson: String?) {
    if (flow?.requestId == requestId) return viewGone(requestId, "interrupted")
    if (requestId == runtime.preparingId) return runtime.preparingGone(requestId)
    if (endedReplies.containsKey(requestId)) {
      log("open: $requestId was recreated after it ended; nothing more to report")
      return
    }
    val envelope = requestJson?.let { PulseJson.parse(it) }
    val request = envelope?.get("args")?.obj ?: emptyMap()
    val callId = envelope?.get("callId")?.string ?: ""
    val ns = envelope?.get("namespace")?.string?.takeIf { PulseKitStorage.isNamespaceName(it) }
    val inbox = ns?.let {
      try {
        storage.roots(it).inbox
      } catch (e: IOException) {
        null
      }
    }
    val hasDraft = PulseKitResults.draftId(request) != null
    val result = inbox?.read(requestId)
      ?: PulseKitResults.interrupted(request, requestId, hasDraft, "interrupted")
    inbox?.writeIfAbsent(result, requestId)
    log("open $callId: $requestId came back without its flow; ended ${result["status"]?.string}")
    endedReplies[requestId] = ReplyEnvelope.success(callId, result).serialized
    emit("flowResult", result)
  }

  /**
   * The reply envelope (`{v, callId, ok: true, result}`) the flow [requestId] ended with, for
   * PulseActivity's Activity result (`RESULT_EXTRA_JSON`); null while it is open or unknown. Kept
   * for the last [ENDED_REPLIES_KEPT] flows of this process. Main thread.
   */
  internal fun endedReply(requestId: String): String? = endedReplies[requestId]

  /** Whether [requestId] is the open flow or the "Preparing…" screen here. Main thread. */
  internal fun isLive(requestId: String): Boolean =
    flow?.requestId == requestId || runtime.preparingId == requestId

  /**
   * Where "Preparing…" starts from: [activity] when it can start one now, else the app's resumed
   * Activity (never one of Pulse's own); null with nothing in front.
   */
  internal fun launchActivity(activity: Activity?): Activity? {
    if (activity != null && activity !is PulseActivity &&
      presenter.state(activity) == PresenterState.IDLE
    ) {
      return activity
    }
    val current = resumed?.get() ?: return null
    if (current is PulseActivity || current.isFinishing) return null
    return if (presenter.state(current) == PresenterState.IDLE) current else null
  }

  // Events

  /** An event envelope (§2.3) to the listener; kept for the next one when none is set. */
  internal fun emit(name: String, payload: PulseJson) {
    val text = PulseEvent(name, payload).serialized
    val l = listener
    if (l != null) return l.onEvent(text)
    if (name == "hostRequest") {
      val id = payload["hostCallId"]?.string ?: return
      retainedEvents.add(Retained(id, name, text))
    } else if (name == "flowResult") {
      retainedEvents.add(Retained(null, name, text))
      val results = retainedEvents.filter { it.name == "flowResult" }
      if (results.size > RETAINED_RESULTS_KEPT) retainedEvents.remove(results.first())
    }
  }

  /** A host request was answered or expired: its retained event goes too. */
  internal fun dropRetainedHostRequest(hostCallId: String) {
    retainedEvents.removeAll { it.hostCallId == hostCallId }
  }

  private fun deliverRetainedEvents() {
    val l = listener ?: return
    if (retainedEvents.isEmpty()) return
    val events = retainedEvents.toList()
    retainedEvents.clear()
    for (event in events) l.onEvent(event.text)
  }

  // Main thread

  /** Run [block] on the main thread: now when already there, else posted. */
  internal fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
  }

  /** Run [block] on the main thread after [delayMs]; [cancel] takes the returned Runnable. */
  internal fun after(delayMs: Long, block: () -> Unit): Runnable {
    val r = Runnable(block)
    main.postDelayed(r, delayMs)
    return r
  }

  internal fun cancel(r: Runnable) {
    main.removeCallbacks(r)
  }

  internal fun log(line: String) = pulseKitLog(line)

  /** The singleton, the frozen entry points and the facade's constants. */
  companion object {
    /** The logcat tag. */
    const val TAG = "PulseKit"

    /** The host writes Pulse JS answers (§3 "JS"): forwarded as `pulse.cmd`. */
    internal val forwardedMethods: List<String> = PulseContract.forwardedMethods

    /** What this facade answers (info().methods): minor 0, and all of minor 1 (PulseKit.swift). */
    internal val methods: List<String> = PulseContract.methods

    /** `close` waits this long for Pulse JS before the facade ends the flow itself. */
    internal const val FORCE_CLOSE_MS = 5_000L

    /** A purge waits this long for Pulse JS to let go of the library. */
    internal const val PURGE_TIMEOUT_MS = 15_000L

    private const val ENDED_REPLIES_KEPT = 16
    private const val RETAINED_RESULTS_KEPT = 16

    @Volatile private var instance: PulseKit? = null

    /** The facade, made on first use with [context]'s application context. Any thread. */
    @JvmStatic
    fun shared(context: Context): PulseKit =
      instance ?: synchronized(this) {
        instance ?: PulseKit(context.applicationContext ?: context).also { kit ->
          instance = kit
          kit.onMain { kit.start() }
        }
      }

    /**
     * The host's launch hook (optional): call it from `Application.onCreate`. It starts the
     * background upload listener (PulseKitUploads) without creating the facade, so Pulse JS's
     * first upload message is heard even when nothing calls [shared] in this process. The first
     * [shared] does the same. Cheap, and safe to call more than once.
     */
    @JvmStatic
    fun prepareBackgroundUploads(context: Context) {
      PulseKitUploads.start(context.applicationContext ?: context)
    }
  }
}

/** The open flow (PulseKit.swift `Flow`). Main thread only. */
internal class PulseKitFlow(
  val requestId: String,
  val callId: String,
  val request: Map<String, PulseJson>,
  val roots: PulseKitRoots,
) {
  /** Every `open` waiting for this request: the first, and any with the same requestId. */
  val waiters = mutableListOf<Pair<String, (ReplyEnvelope) -> Unit>>()

  /** `close`'s 5 s deadline, once a close came. */
  var forceClose: Runnable? = null

  /**
   * The `pulse.cmd` callIds sent while this flow was open; `finish` drops the ones still waiting,
   * since a runtime that died or wasn't listening yet will never reply.
   */
  val commandIds = mutableListOf<String>()

  /** The last `pulse.ui` hasTake: a take would be lost if the flow ended now. */
  var hasTake = false

  /** PulseActivity said the flow is on screen. */
  var shown = false
}
