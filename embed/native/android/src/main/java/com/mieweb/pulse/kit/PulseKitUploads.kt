// Mirrors embed/native/ios/PulseKitBackground.swift (`PulseKitUploads`): PulseKit's side of the
// `pulse.upload` protocol (O16, PR4-E). The rules are in core/PulseUploadRules.kt; this file is the
// Android glue: BrownfieldMessaging, OkHttp and PulseUploadService.

package com.mieweb.pulse.kit

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.mieweb.pulse.kit.core.PulseProgressThrottle
import com.mieweb.pulse.kit.core.PulseUploadCall
import com.mieweb.pulse.kit.core.PulseUploadOp
import com.mieweb.pulse.kit.core.PulseUploadRules
import com.mieweb.pulse.kit.core.PulseUploadWaiter
import expo.modules.brownfield.BrownfieldMessaging
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink

/**
 * Background uploads on Android (G3, F7, O16). Pulse JS's TUS client (native-chunk-upload.ts) hands
 * each PATCH to PulseKit over BrownfieldMessaging; PulseKit runs it as ONE OkHttp PATCH of all the
 * bytes left, inside [PulseUploadService], a dataSync foreground service. The PATCH keeps going
 * after Pulse closes, with the host in the background, the screen locked or the task swiped away.
 *
 * Where Android differs from iOS (PR4-SPEC "Android differences"):
 * - Android has no out-of-process transfer daemon like `nsurlsessiond`. The PATCH lives in this
 *   process: a kill (force-stop, `am kill`, a crash, the low-memory killer) ends it, and nothing
 *   is left to `attach` to afterwards (`attach` answers `{attached:false}` at once). Pulse JS then
 *   HEADs the upload and resumes from the server's offset.
 * - No staging copy: the request body streams the file from `offset` for `length` bytes through a
 *   [FileChannel][java.nio.channels.FileChannel], where iOS copies the slice to a file because a
 *   background task uploads whole files only.
 * - Redirects aren't followed (`followRedirects(false)`): a 3xx reaches Pulse JS as the PATCH's
 *   status, which tus-client.ts treats as a failure. This closes, for PulseKit's PATCH on
 *   Android, the redirect gap native-chunk-upload.ts documents for expo-file-system's task (which
 *   follows a redirect and resends `Authorization` to its target).
 * - The client is PulseKit's own OkHttp instance (OkHttp comes with react-android; no new
 *   dependency): no read or call timeout, so a long PATCH and the server's time to answer after
 *   the last byte never time out; a write that makes no progress for [WRITE_TIMEOUT_S] seconds
 *   fails (a dead socket), and so does a connection not made in [CONNECT_TIMEOUT_S] seconds. No
 *   retry on a connection failure: a PATCH runs once, and Pulse JS decides what's next after a
 *   HEAD.
 * - If Android refuses to start the foreground service (`ForegroundServiceStartNotAllowedException`
 *   on 12+, when the PATCH comes while the host is in the background), the PATCH runs without it
 *   and ends as it may; that's logged.
 *
 * The listener starts on [start] (PulseKit's init and `prepareBackgroundUploads` call it), with no
 * UI and no React Native runtime, so Pulse JS's first message (`hello`) always finds it. All state
 * lives on one thread ([executor]), as Swift keeps it on its serial queue. Messages to Pulse JS go
 * through `BrownfieldMessaging.sendMessage` on the main thread; with no JS runtime listening it
 * drops them, the call still finishes, and Pulse JS HEADs the upload on its next run.
 */
internal object PulseKitUploads {
  private const val TAG = "PulseKit"
  private const val CONNECT_TIMEOUT_S = 30L
  private const val WRITE_TIMEOUT_S = 60L

  /** How much of the file one write to the socket carries. */
  private const val BODY_BUFFER_BYTES = 64 * 1024

  /** What the service shows: calls running, and their bytes sent of their bytes to send. */
  data class Snapshot(val calls: Int, val sent: Long, val total: Long)

  /** One PATCH in flight, and the Pulse JS ids waiting for it. Touched on [executor] only. */
  private class Running(
    val url: String,
    val path: String,
    val offset: Long,
    val length: Long,
    /** The throttle's key: the id of the PATCH that started the call. */
    val key: String,
  ) {
    val waiters = ArrayList<PulseUploadWaiter>()
    var call: Call? = null

    /** Body bytes written so far (the OkHttp thread writes it). */
    @Volatile var bodySent = 0L

    /** Set when PulseKit cancelled the call: what its waiters are told, and whether as a cancel. */
    var stopReason: String? = null
    var stopCanceled = true
  }

  private val started = AtomicBoolean(false)
  private val main = Handler(Looper.getMainLooper())
  private val executor: ExecutorService =
    Executors.newSingleThreadExecutor { r ->
      Thread(r, "pulsekit-upload").apply { isDaemon = true }
    }
  private val throttle = PulseProgressThrottle()

  /** Every call not yet finished, in start order (a cancelled one stays until OkHttp ends it). */
  private val runs = ArrayList<Running>()
  private var libraryRoots: List<String> = emptyList()

  @Volatile private var appContext: Context? = null

  /** The latest [Snapshot], read by [PulseUploadService] on the main thread. */
  @Volatile
  var snapshot = Snapshot(0, 0, 0)
    private set

  private val client: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(CONNECT_TIMEOUT_S, TimeUnit.SECONDS)
      .writeTimeout(WRITE_TIMEOUT_S, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .callTimeout(0, TimeUnit.MILLISECONDS)
      .followRedirects(false)
      .followSslRedirects(false)
      .retryOnConnectionFailure(false)
      .build()
  }

  /**
   * Listen for Pulse JS's `pulse.upload` messages. Idempotent; any thread. BrownfieldMessaging's
   * listeners are a plain set its sender reads, so the listener is added on the main thread (as
   * PulseKit.swift and PulseKitBackground.swift do).
   */
  fun start(context: Context) {
    if (!started.compareAndSet(false, true)) return
    val app = context.applicationContext ?: context
    appContext = app
    val roots = LinkedHashSet<String>()
    // PulseKit's library (PR4-C's storage roots): filesDir/PulseKit (S1-c); noBackupFilesDir is
    // accepted too, as the spec first placed it. Both as given and with links resolved.
    for (base in listOf(app.filesDir, app.noBackupFilesDir)) {
      val lib = File(base, "PulseKit")
      roots.add(lib.absolutePath)
      runCatching { lib.canonicalPath }.getOrNull()?.let(roots::add)
    }
    executor.execute { libraryRoots = roots.toList() }
    main.post {
      BrownfieldMessaging.addListener { message ->
        if (message["type"] == PulseUploadRules.TYPE) executor.execute { onMessage(message) }
      }
      log("listening")
    }
  }

  /**
   * Android 15's dataSync time limit ran out ([PulseUploadService.onTimeout]): every call stops
   * and ends not-ok (not as a cancel), so Pulse JS resumes the uploads from the server's offset
   * later.
   */
  fun stopAll(reason: String) {
    executor.execute {
      for (run in runs) stop(run, reason, canceled = false)
      publish()
    }
  }

  // Messages from Pulse JS (on executor) ---------------------------------------------------------

  private fun onMessage(message: Map<String, Any?>) {
    when (val op = PulseUploadRules.parse(message, libraryRoots) ?: return) {
      is PulseUploadOp.Hello -> send(PulseUploadRules.endOk(op.id))
      is PulseUploadOp.Patch -> patch(op)
      is PulseUploadOp.Attach -> attach(op)
      is PulseUploadOp.Cancel -> cancel(op.id)
      is PulseUploadOp.Sweep -> sweep(op)
      is PulseUploadOp.Invalid -> fail(op.id, op.message)
    }
  }

  private fun attachable(url: String): Running? =
    runs.firstOrNull { it.url == url && it.stopReason == null }

  private fun patch(op: PulseUploadOp.Patch) {
    // §6.3 step 1: a call still running for this upload is joined, not duplicated.
    attachable(op.url)?.let { running ->
      log("PATCH ${op.id}: attached to the call for ${running.key}")
      running.waiters.add(PulseUploadWaiter(op.id, op.offset))
      return
    }
    val file = File(op.path)
    if (!file.isFile || file.length() < op.offset + op.length) {
      return fail(op.id, "Couldn't read ${op.length} bytes from ${op.offset} of ${op.path}.")
    }
    val headers = PulseUploadRules.patchHeaders(op.headers, op.offset, op.length)
    val run = Running(op.url, op.path, op.offset, op.length, op.id)
    val request =
      try {
        val builder = Request.Builder().url(op.url)
        for ((name, value) in headers) builder.header(name, value)
        builder.method("PATCH", FileSliceBody(file, op.offset, op.length, run)).build()
      } catch (e: IllegalArgumentException) {
        return fail(op.id, "Couldn't make the PATCH: ${e.message}")
      }
    run.waiters.add(PulseUploadWaiter(op.id, op.offset))
    runs.add(run)
    publish()
    val call = client.newCall(request)
    run.call = call
    call.enqueue(
      object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          executor.execute { finish(run, null, emptyMap(), e) }
        }

        override fun onResponse(call: Call, response: Response) {
          val status = response.code
          val headers = PulseUploadRules.responseHeaders(response.headers.toMultimap())
          response.close()
          executor.execute { finish(run, status, headers, null) }
        }
      }
    )
    log("PATCH ${op.id}: ${op.length} bytes from ${op.offset}")
  }

  /**
   * Wait for the call still running for the URL before Pulse JS HEADs the upload (the HEAD would
   * take PulseVault's upload lock and cut that PATCH). Answers `{attached:false}` at once when none
   * runs, which after a process kill is always (see the class KDoc).
   */
  private fun attach(op: PulseUploadOp.Attach) {
    val running = attachable(op.url) ?: return send(PulseUploadRules.endNotAttached(op.id))
    log("attach ${op.id}: waiting for the call for ${running.key}")
    running.waiters.add(PulseUploadWaiter(op.id, 0))
  }

  /** Pulse JS stopped waiting for [id]: the call goes too when nobody else waits for it. */
  private fun cancel(id: String) {
    for (run in runs.toList()) {
      if (!run.waiters.removeAll { it.id == id }) continue
      if (run.waiters.isEmpty()) stop(run, "Cancelled.", canceled = true)
    }
    send(PulseUploadRules.endCancelled(id))
    publish()
  }

  /**
   * Cancel the calls of the calling runtime's namespace (files under `root`) whose upload isn't in
   * `live`. Only that runtime knows which of its jobs are live.
   */
  private fun sweep(op: PulseUploadOp.Sweep) {
    val open = runs.filter { it.stopReason == null }
    val chosen =
      PulseUploadRules.sweep(open.map { PulseUploadCall(it.url, it.path) }, op.root, op.live)
        .toSet()
    var cancelled = 0
    for (run in open) {
      if (PulseUploadCall(run.url, run.path) !in chosen) continue
      stop(run, "Cancelled.", canceled = true)
      cancelled++
    }
    if (cancelled > 0) log("sweep ${op.namespace}: $cancelled call(s) of no live job cancelled")
    send(PulseUploadRules.endSwept(op.id, cancelled))
    if (cancelled > 0) publish()
  }

  private fun stop(run: Running, reason: String, canceled: Boolean) {
    if (run.stopReason != null) return
    run.stopReason = reason
    run.stopCanceled = canceled
    run.call?.cancel()
  }

  // Calls (on executor) --------------------------------------------------------------------------

  private fun progress(run: Running, bodySent: Long) {
    for (waiter in run.waiters) {
      val sent = PulseUploadRules.sentFor(run.offset, bodySent, waiter.offset)
      send(PulseUploadRules.progress(waiter.id, sent))
    }
    publish()
  }

  private fun finish(
    run: Running,
    status: Int?,
    headers: Map<String, String>,
    error: IOException?,
  ) {
    if (!runs.remove(run)) return
    throttle.forget(run.key)
    val waiters = run.waiters.toList()
    run.waiters.clear()
    val reason = run.stopReason
    when {
      reason != null -> {
        log("call for ${run.key} stopped: $reason")
        for (w in waiters) send(PulseUploadRules.endFailed(w.id, reason, run.stopCanceled))
      }
      status != null && error == null -> {
        log("call for ${run.key} ended: HTTP $status")
        for (w in waiters) send(PulseUploadRules.endResponse(w.id, status, headers))
      }
      else -> {
        val message = error?.message?.takeIf { it.isNotBlank() } ?: "The upload failed."
        log("call for ${run.key} failed: ${error?.javaClass?.simpleName}: $message")
        for (w in waiters) send(PulseUploadRules.endFailed(w.id, message))
      }
    }
    publish()
  }

  /** Updates [snapshot] and tells the service: started for the first call, ended after the last. */
  private fun publish() {
    val active = runs.filter { it.stopReason == null }
    val next = Snapshot(active.size, active.sumOf { it.bodySent }, active.sumOf { it.length })
    // A new call (re)starts the service; begin() is a no-op update while it runs. Trying again for
    // each new call means one refused from the background doesn't leave later calls without it.
    val grew = next.calls > snapshot.calls
    snapshot = next
    val context = appContext ?: return
    main.post {
      when {
        next.calls == 0 -> PulseUploadService.end()
        grew -> {
          if (!PulseUploadService.begin(context)) {
            log("the foreground service wasn't allowed to start; the upload runs without it")
          }
        }
        else -> PulseUploadService.update()
      }
    }
  }

  // Helpers --------------------------------------------------------------------------------------

  private fun fail(id: String, message: String) {
    log("upload $id: $message")
    send(PulseUploadRules.endFailed(id, message))
  }

  private fun send(message: Map<String, Any?>) {
    main.post {
      try {
        BrownfieldMessaging.sendMessage(message)
      } catch (e: RuntimeException) {
        // The runtime went away mid-send: Pulse JS HEADs the upload on its next run.
        log("couldn't reach Pulse JS: ${e.message}")
      }
    }
  }

  internal fun log(line: String) {
    Log.i(TAG, "upload: $line")
  }

  /**
   * A PATCH body: [length] bytes of [file] from [offset], read through a FileChannel straight into
   * the socket (no staging copy), counting what's written for progress. Not one-shot: OkHttp may
   * write it again (it doesn't retry here, but the contract allows it), and each write starts
   * over from [offset].
   */
  private class FileSliceBody(
    private val file: File,
    private val offset: Long,
    private val length: Long,
    private val run: Running,
  ) : RequestBody() {
    override fun contentType(): MediaType? = PulseUploadRules.CONTENT_TYPE.toMediaTypeOrNull()

    override fun contentLength(): Long = length

    override fun writeTo(sink: BufferedSink) {
      RandomAccessFile(file, "r").use { raf ->
        val channel = raf.channel
        val buffer = ByteBuffer.allocate(BODY_BUFFER_BYTES)
        var position = offset
        var written = 0L
        run.bodySent = 0
        while (written < length) {
          buffer.clear()
          val want = minOf(buffer.capacity().toLong(), length - written).toInt()
          buffer.limit(want)
          val read = channel.read(buffer, position)
          if (read <= 0) throw IOException("The file ended before ${length - written} more bytes.")
          buffer.flip()
          sink.write(buffer)
          position += read
          written += read
          run.bodySent = written
          val now = SystemClock.elapsedRealtime()
          PulseKitUploads.throttle.offer(run.key, written, now)?.let { sent ->
            PulseKitUploads.executor.execute { PulseKitUploads.progress(run, sent) }
          }
        }
        sink.flush()
        PulseKitUploads.throttle.flush(run.key)?.let { sent ->
          PulseKitUploads.executor.execute { PulseKitUploads.progress(run, sent) }
        }
      }
    }
  }
}
