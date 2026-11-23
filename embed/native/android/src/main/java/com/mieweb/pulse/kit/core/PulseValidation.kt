// Mirrors embed/native/ios/PulseKitEnvelope.swift (`pulseIsPlainName`, `PulseOpenArgs`,
// `PulseArgs.open`, `PulseArgs.configure`, `PulseNamespace.isValidHostId`) and, for the context's
// size, src/db/host-context.ts (`hostContextColumns`). Checked by envelope.json's `open` and
// `configure` sections on the JVM.

package com.mieweb.pulse.kit.core

/** `open`'s arguments after the facade's checks. The rest of the request goes to Pulse JS whole. */
data class PulseOpenArgs(
  /** The caller's idempotency key; null means "make one". */
  val requestId: String?,
  val entry: String,
  val request: Map<String, PulseJson>,
)

/** The outcome of a check that either accepts a value or refuses with `invalid_options`. */
sealed class PulseChecked<out T> {
  /** Accepted. */
  data class Ok<T>(val value: T) : PulseChecked<T>()

  /** Refused, with the error to reply. */
  data class Invalid(val error: PulseError) : PulseChecked<Nothing>()
}

/** Argument rules the facade applies before anything is presented or stored. */
object PulseValidation {
  /** A context's (and an upload type's) largest size as UTF-8 JSON (host-context.ts). */
  const val CONTEXT_JSON_MAX_BYTES = 8 * 1024

  /** A hostId's longest length. */
  const val HOST_ID_MAX = 40

  /** A plain name's longest length (request ids, namespaces). */
  const val PLAIN_NAME_MAX = 64

  /**
   * A plain file-name-safe id: 1–64 of `[A-Za-z0-9._-]`, never `.` or `..`. Request ids and
   * namespaces become file and folder names, so nothing else gets near the file system.
   */
  @JvmStatic
  /**
   * A requestId: a plain name that doesn't end in `.project`. Its result is `<id>.json` in the inbox,
   * and `<id>.project.json` is a project document there, never a result (as on iOS).
   */
  fun isRequestId(s: String): Boolean = isPlainName(s) && !s.endsWith(".project")

  fun isPlainName(s: String): Boolean =
    s.isNotEmpty() && s.length <= PLAIN_NAME_MAX && s != "." && s != ".." &&
      s.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it in "._-" }

  /** `ConfigureOptions.hostId`: 1–40 of `[a-z0-9.-]` with at least one letter or digit. */
  @JvmStatic
  fun isValidHostId(s: String): Boolean =
    s.isNotEmpty() && s.length <= HOST_ID_MAX && s.all(::isHostIdChar) &&
      s.any { it in 'a'..'z' || it in '0'..'9' }

  internal fun isHostIdChar(c: Char): Boolean =
    c in 'a'..'z' || c in '0'..'9' || c == '.' || c == '-'

  /** Check `open` before anything is presented: a bad request fails without a screen. */
  @JvmStatic
  fun open(args: Map<String, PulseJson>, callId: String): PulseChecked<PulseOpenArgs> {
    fun bad(message: String) =
      PulseChecked.Invalid(PulseError.of("invalid_options", message, callId))

    var requestId: String? = null
    val r = args["requestId"]
    if (r != null && r != PulseJson.Null) {
      val s = r.string
      if (s == null || !isRequestId(s)) {
        return bad(
          "requestId must be 1–64 letters, digits, dots, dashes or underscores, not ending in .project.",
        )
      }
      requestId = s
    }
    val entry = args["entry"]?.string ?: return bad("open needs an entry.")
    if (entry !in PulseContract.entries) return bad("Pulse has no entry named $entry.")
    val t = args["theme"]
    if (t != null && t != PulseJson.Null && t.obj == null) return bad("theme must be an object.")
    when (entry) {
      "record" -> {
        val key = args["context"]?.get("key")?.string
        if (key.isNullOrEmpty()) return bad("record needs a context with a key.")
        val d = args["draft"]
        if (d != null && d != PulseJson.Null) {
          val isNew = d.string == "new"
          val continues = d["continue"]?.string?.isNotEmpty() ?: false
          if (!isNew && !continues) return bad("draft must be 'new' or { continue: draftId }.")
        }
      }
      else -> {
        val id = args["draftId"]?.string
        if (id.isNullOrEmpty()) return bad("$entry needs a draftId.")
      }
    }
    return PulseChecked.Ok(PulseOpenArgs(requestId, entry, args))
  }

  /** `configure`: checks only what the facade itself uses; Pulse JS reads the rest. */
  @JvmStatic
  fun configure(args: Map<String, PulseJson>, callId: String): PulseError? {
    fun bad(message: String) = PulseError.of("invalid_options", message, callId)

    val h = args["hostId"]
    if (h != null && h != PulseJson.Null) {
      val s = h.string
      if (s == null || !isValidHostId(s)) {
        return bad("hostId must be 1–40 of a-z, 0-9, dots and dashes.")
      }
    }
    val m = args["uploadMode"]
    if (m != null && m != PulseJson.Null) {
      val s = m.string
      if (s == null || s !in listOf("pulse", "file")) {
        return bad("uploadMode must be 'pulse' or 'file'.")
      }
    }
    for (key in listOf("policy", "theme", "models")) {
      val v = args[key]
      if (v != null && v != PulseJson.Null && v.obj == null) return bad("$key must be an object.")
    }
    return null
  }

  // MARK: The 8 KB context limit (host-context.ts)

  /**
   * How many UTF-8 bytes Pulse JS will store for [context]: the context without its `key` and
   * `uploadType`, as `JSON.stringify` writes it (host-context.ts `contextJson`). Null when it
   * isn't an object.
   */
  @JvmStatic
  fun contextJsonBytes(context: PulseJson): Int? {
    val o = context.obj ?: return null
    val rest = LinkedHashMap<String, PulseJson>()
    for ((k, v) in o) if (k != "key" && k != "label" && k != "uploadType") rest[k] = v
    o["label"]?.let { rest["label"] = it }
    return jsonBytes(PulseJson.Obj(rest))
  }

  /** UTF-8 bytes of [value] as `JSON.stringify` writes it. */
  @JvmStatic
  fun jsonBytes(value: PulseJson): Int =
    value.write(sortKeys = false, style = PulseJson.NumberStyle.JS).toByteArray(Charsets.UTF_8).size

  /**
   * Pulse JS's size rule for a context, checked natively: the context (without key and upload
   * type) and its `uploadType` are each at most [CONTEXT_JSON_MAX_BYTES] as UTF-8 JSON, else
   * `invalid_options`. Null when it fits or [context] isn't an object (the other checks own that).
   *
   * Not part of [open]: the Swift facade leaves this rule to Pulse JS (host-context.ts), and the
   * Android facade keeps the same answers unless the owner moves the check into both.
   */
  @JvmStatic
  fun checkContextSize(context: PulseJson?, callId: String): PulseError? {
    if (context == null) return null
    val bytes = contextJsonBytes(context) ?: return null
    if (bytes > CONTEXT_JSON_MAX_BYTES) {
      return PulseError.of(
        "invalid_options",
        "The context is $bytes bytes as JSON, over $CONTEXT_JSON_MAX_BYTES.",
        callId,
      )
    }
    val type = context["uploadType"]
    if (type != null && type != PulseJson.Null) {
      val typeBytes = jsonBytes(type)
      if (typeBytes > CONTEXT_JSON_MAX_BYTES) {
        return PulseError.of(
          "invalid_options",
          "The upload type is $typeBytes bytes as JSON, over $CONTEXT_JSON_MAX_BYTES.",
          callId,
        )
      }
    }
    return null
  }
}
