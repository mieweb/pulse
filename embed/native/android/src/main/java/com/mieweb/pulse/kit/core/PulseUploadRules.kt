// Mirrors embed/native/ios/PulseKitBackground.swift (`PulseKitUploads`): the pure half of the
// `pulse.upload` protocol (O16). Pulse JS's TUS client (src/features/upload/core/
// native-chunk-upload.ts) hands each PATCH of the bytes left to PulseKit; on Android,
// PulseKitUploads.kt runs it with OkHttp in PulseUploadService.kt. Everything a vector can pin
// lives here: reading a message, the replies with the iOS field names, the progress throttle,
// the sweep's choice and the PATCH's headers. Checked by jvm-tests' UploadRulesMain on the JVM.
//
//     JS → PulseKit  {type:"pulse.upload", op:"hello"|"patch"|"attach"|"cancel"|"sweep", id, ...}
//     PulseKit → JS  {type:"pulse.upload.progress", id, sent}
//                    {type:"pulse.upload.end", id, ok, status?, headers?, cancelled?, error?}

package com.mieweb.pulse.kit.core

/**
 * One `pulse.upload` message from Pulse JS, read and checked. Every op carries the message [id]
 * its answer names.
 */
sealed class PulseUploadOp {
  /** The message id the answer (`pulse.upload.end`) and any progress name. */
  abstract val id: String

  /** Is PulseKit's uploader there? Answered `{ok:true}` at once. */
  data class Hello(override val id: String) : PulseUploadOp()

  /**
   * Send [length] bytes of the file at [path] from [offset] to the upload at [url], or wait for
   * the call already running for [url].
   *
   * @property namespace The PulseKit namespace [path] is in.
   * @property headers Pulse JS's headers (string values only), before
   *   [PulseUploadRules.patchHeaders].
   */
  data class Patch(
    override val id: String,
    val url: String,
    val offset: Long,
    val length: Long,
    val path: String,
    val namespace: String,
    val headers: Map<String, String>,
  ) : PulseUploadOp()

  /**
   * Wait for the call running for [url], if any (Pulse JS asks before it HEADs the upload).
   *
   * @property namespace The PulseKit namespace [path] is in.
   */
  data class Attach(
    override val id: String,
    val url: String,
    val path: String,
    val namespace: String,
  ) : PulseUploadOp()

  /** Pulse JS stopped waiting for [id]. */
  data class Cancel(override val id: String) : PulseUploadOp()

  /**
   * Cancel the calls, in the namespace whose documents folder is [root], of uploads not in [live].
   *
   * @property namespace The PulseKit namespace [root] is in.
   */
  data class Sweep(
    override val id: String,
    val root: String,
    val namespace: String,
    val live: Set<String>,
  ) : PulseUploadOp()

  /** A message PulseKit can't run; answered with [PulseUploadRules.endFailed] and [message]. */
  data class Invalid(override val id: String, val message: String) : PulseUploadOp()
}

/** A call PulseKit is running, as the sweep sees it: its upload URL and the file it sends. */
data class PulseUploadCall(val url: String, val path: String)

/** One PATCH's waiter: the message id and the offset it asked to send from (0 for `attach`). */
data class PulseUploadWaiter(val id: String, val offset: Long)

/** The `pulse.upload` protocol's rules. Messages are BrownfieldMessaging's `Map<String, Any?>`. */
object PulseUploadRules {
  /** Pulse JS's messages. */
  const val TYPE = "pulse.upload"

  /** PulseKit's progress messages. */
  const val PROGRESS = "pulse.upload.progress"

  /** PulseKit's answers, one per message id. */
  const val END = "pulse.upload.end"

  /** The TUS version when Pulse JS's headers don't name one (tus-client.ts sends 1.0.0). */
  const val TUS_VERSION = "1.0.0"

  /** A TUS PATCH body's content type. */
  const val CONTENT_TYPE = "application/offset+octet-stream"

  /** Progress messages per id are at least this far apart (at most 4 a second). */
  const val PROGRESS_INTERVAL_MS = 250L

  /** The headers [patchHeaders] sets itself, lowercased. */
  private val OWN_HEADERS =
    setOf("tus-resumable", "upload-offset", "content-type", "content-length")

  /**
   * Reads one message from Pulse JS. Null (dropped, no answer) when it isn't a `pulse.upload`
   * message or has no string `id` or `op`, as Swift's `onMessage` guard. Files must be in a
   * PulseKit namespace: the first folder under one of [libraryRoots] (`<files>/PulseKit`), named
   * like a namespace.
   *
   * Numbers arrive as JS numbers (`Double` through expo's converter); `offset` and `length` must
   * be whole, `offset` ≥ 0 and `length` > 0.
   */
  @JvmStatic
  fun parse(message: Map<String, Any?>, libraryRoots: List<String>): PulseUploadOp? {
    if (message["type"] != TYPE) return null
    val id = message["id"] as? String ?: return null
    val op = message["op"] as? String ?: return null
    return when (op) {
      "hello" -> PulseUploadOp.Hello(id)
      "patch" -> parsePatch(id, message, libraryRoots)
      "attach" -> {
        val url = (message["url"] as? String)?.takeIf(::isHttpUrl)
        val path = message["path"] as? String
        val ns = path?.let { namespaceOf(it, libraryRoots) }
        if (url == null || path == null || ns == null) {
          PulseUploadOp.Invalid(id, "An attach needs url, and a path in a PulseKit namespace.")
        } else {
          PulseUploadOp.Attach(id, url, path, ns)
        }
      }
      "cancel" -> PulseUploadOp.Cancel(id)
      "sweep" -> {
        val root = message["root"] as? String
        val ns = root?.let { namespaceOf(it, libraryRoots) }
        val live = (message["live"] as? List<*>)?.filterIsInstance<String>()?.toSet() ?: emptySet()
        if (root == null || ns == null) {
          PulseUploadOp.Invalid(id, "A sweep needs the documents folder of a PulseKit namespace.")
        } else {
          PulseUploadOp.Sweep(id, root, ns, live)
        }
      }
      else -> PulseUploadOp.Invalid(id, "Unknown upload operation $op.")
    }
  }

  private fun parsePatch(
    id: String,
    message: Map<String, Any?>,
    libraryRoots: List<String>,
  ): PulseUploadOp {
    val url = (message["url"] as? String)?.takeIf(::isHttpUrl)
    val offset = wholeNumber(message["offset"])?.takeIf { it >= 0 }
    val length = wholeNumber(message["length"])?.takeIf { it > 0 }
    val path = message["path"] as? String
    if (url == null || offset == null || length == null || path == null) {
      return PulseUploadOp.Invalid(id, "A PATCH needs url, offset, length and path.")
    }
    val ns =
      namespaceOf(path, libraryRoots)
        ?: return PulseUploadOp.Invalid(id, "$path isn't in a PulseKit namespace.")
    val headers = LinkedHashMap<String, String>()
    (message["headers"] as? Map<*, *>)?.forEach { (name, value) ->
      if (name is String && value is String) headers[name] = value
    }
    return PulseUploadOp.Patch(id, url, offset, length, path, ns, headers)
  }

  /** A JS number that is a whole value (or an integer type), as a Long; else null. */
  @JvmStatic
  fun wholeNumber(value: Any?): Long? =
    when (value) {
      is Int -> value.toLong()
      is Long -> value
      is Short -> value.toLong()
      is Byte -> value.toLong()
      is Double ->
        if (value.isFinite() && value == Math.floor(value) && kotlin.math.abs(value) <= 9.007e15) {
          value.toLong()
        } else {
          null
        }
      is Float -> wholeNumber(value.toDouble())
      else -> null
    }

  /** An absolute `http:` or `https:` URL with something after the scheme. */
  @JvmStatic
  fun isHttpUrl(url: String): Boolean {
    val lower = url.lowercase()
    val rest =
      when {
        lower.startsWith("https://") -> url.substring(8)
        lower.startsWith("http://") -> url.substring(7)
        else -> return false
      }
    return rest.isNotEmpty() && rest[0] != '/' && rest.none { it.isWhitespace() }
  }

  // Paths ----------------------------------------------------------------------------------------

  /**
   * An absolute path with `.`, `..`, repeated and trailing slashes resolved by text alone (no file
   * system: symlinks stay as written). A `file://` prefix is dropped. Null when it isn't absolute.
   */
  @JvmStatic
  fun normalise(path: String): String? {
    val plain = if (path.startsWith("file://")) path.substring(7) else path
    if (!plain.startsWith("/")) return null
    val parts = ArrayList<String>()
    for (part in plain.split('/')) {
      when (part) {
        "", "." -> {}
        ".." -> if (parts.isNotEmpty()) parts.removeAt(parts.size - 1)
        else -> parts.add(part)
      }
    }
    return "/" + parts.joinToString("/")
  }

  /** Whether [path] is strictly inside the folder [root] (both normalised first). */
  @JvmStatic
  fun isUnder(path: String, root: String): Boolean {
    val p = normalise(path) ?: return false
    val r = normalise(root) ?: return false
    return if (r == "/") p != "/" else p.startsWith("$r/")
  }

  /**
   * The namespace a file (or a namespace's documents folder itself) belongs to: its first folder
   * under one of [libraryRoots], when that folder is named like a namespace (a plain name not
   * starting with a dot, as Swift's `PulseKitStorage.isNamespaceName`). Null otherwise.
   */
  @JvmStatic
  fun namespaceOf(path: String, libraryRoots: List<String>): String? {
    val p = normalise(path) ?: return null
    for (root in libraryRoots) {
      val r = normalise(root) ?: continue
      if (r == "/" || !p.startsWith("$r/")) continue
      val first = p.substring(r.length + 1).substringBefore('/')
      if (PulseValidation.isPlainName(first) && !first.startsWith(".")) return first
    }
    return null
  }

  /**
   * The calls a sweep cancels: those whose file is under [root] (the calling runtime's documents
   * folder, so its namespace only) and whose upload isn't in [live]. Another namespace's calls are
   * left to its own runtime.
   */
  @JvmStatic
  fun sweep(calls: List<PulseUploadCall>, root: String, live: Set<String>): List<PulseUploadCall> =
    calls.filter { isUnder(it.path, root) && it.url !in live }

  // The PATCH ------------------------------------------------------------------------------------

  /**
   * The PATCH's headers: Pulse JS's (its authorization among them), with `Tus-Resumable` (Pulse
   * JS's value, else [TUS_VERSION]), `Upload-Offset` [offset], `Content-Type` [CONTENT_TYPE] and
   * `Content-Length` [length] set here whatever their casing in [given].
   */
  @JvmStatic
  fun patchHeaders(given: Map<String, String>, offset: Long, length: Long): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    val tus = given.entries.firstOrNull { it.key.equals("Tus-Resumable", ignoreCase = true) }?.value
    for ((name, value) in given) {
      if (name.lowercase() !in OWN_HEADERS) out[name] = value
    }
    out["Tus-Resumable"] = tus ?: TUS_VERSION
    out["Upload-Offset"] = offset.toString()
    out["Content-Type"] = CONTENT_TYPE
    out["Content-Length"] = length.toString()
    return out
  }

  /**
   * What a waiter has sent: the upload's position (the call's [callOffset] plus the [bodySent]
   * bytes of its body) less where the waiter started ([waiterOffset]; 0 for `attach`, which then
   * sees the upload's offset). Never negative.
   */
  @JvmStatic
  fun sentFor(callOffset: Long, bodySent: Long, waiterOffset: Long): Long =
    maxOf(0L, callOffset + bodySent - waiterOffset)

  /** A response's headers, one value per name: repeated headers joined with ", ". */
  @JvmStatic
  fun responseHeaders(multimap: Map<String, List<String>>): Map<String, String> {
    val out = LinkedHashMap<String, String>()
    for ((name, values) in multimap) out[name] = values.joinToString(", ")
    return out
  }

  // Messages to Pulse JS -------------------------------------------------------------------------

  /** `{type:"pulse.upload.progress", id, sent}`; `sent` is a Double, as JS reads every number. */
  @JvmStatic
  fun progress(id: String, sent: Long): Map<String, Any?> =
    linkedMapOf("type" to PROGRESS, "id" to id, "sent" to sent.toDouble())

  /** `hello`'s answer: `{ok:true}`. */
  @JvmStatic
  fun endOk(id: String): Map<String, Any?> = end(id, "ok" to true)

  /** A PATCH (or attach) that got an HTTP response, any status: `{ok:true, status, headers}`. */
  @JvmStatic
  fun endResponse(id: String, status: Int, headers: Map<String, String>): Map<String, Any?> =
    end(id, "ok" to true, "status" to status, "headers" to headers)

  /** `attach` with no call running for the URL: `{ok:true, attached:false}`. */
  @JvmStatic
  fun endNotAttached(id: String): Map<String, Any?> = end(id, "ok" to true, "attached" to false)

  /** A sweep's answer: `{ok:true, cancelled:n}`. */
  @JvmStatic
  fun endSwept(id: String, cancelled: Int): Map<String, Any?> =
    end(id, "ok" to true, "cancelled" to cancelled)

  /**
   * A call that ended without a response, or a message PulseKit couldn't run:
   * `{ok:false, error:{message, canceled}}`. Pulse JS rejects with an AbortError when [canceled].
   */
  @JvmStatic
  fun endFailed(id: String, message: String, canceled: Boolean = false): Map<String, Any?> =
    end(id, "ok" to false, "error" to linkedMapOf("message" to message, "canceled" to canceled))

  /** `cancel`'s answer to the id it cancels. */
  @JvmStatic
  fun endCancelled(id: String): Map<String, Any?> = endFailed(id, "Cancelled.", canceled = true)

  private fun end(id: String, vararg fields: Pair<String, Any?>): Map<String, Any?> {
    val out = linkedMapOf<String, Any?>("type" to END, "id" to id)
    for ((name, value) in fields) out[name] = value
    return out
  }
}

/**
 * Progress throttling: at most one message per [intervalMs] per key (4 a second at the default),
 * and the last value is never lost: [offer] holds back what it drops, and [flush] hands over the
 * held value when the body is done. Safe to call from any thread.
 */
class PulseProgressThrottle(private val intervalMs: Long = PulseUploadRules.PROGRESS_INTERVAL_MS) {
  private class Slot(var lastAt: Long, var held: Long?)

  private val slots = HashMap<String, Slot>()

  /** [value] at [nowMs] (a monotonic clock): the value to send now, or null when held back. */
  @Synchronized
  fun offer(key: String, value: Long, nowMs: Long): Long? {
    val slot = slots[key]
    if (slot == null) {
      slots[key] = Slot(nowMs, null)
      return value
    }
    if (nowMs - slot.lastAt >= intervalMs) {
      slot.lastAt = nowMs
      slot.held = null
      return value
    }
    slot.held = value
    return null
  }

  /** The value held back since the last one sent, if any (then it counts as sent). */
  @Synchronized
  fun flush(key: String): Long? {
    val slot = slots[key] ?: return null
    val held = slot.held
    slot.held = null
    return held
  }

  /** Drops [key]'s state (its call ended). */
  @Synchronized
  fun forget(key: String) {
    slots.remove(key)
  }
}
