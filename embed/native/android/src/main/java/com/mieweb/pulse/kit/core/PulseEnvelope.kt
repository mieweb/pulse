// Mirrors embed/native/ios/PulseKitEnvelope.swift (PulseContract, PulseErrorInfo, PulseRequest,
// PulseReply, PulseEvent) and the method lists in PulseKit.swift. native-bridge.md §2 and §3 are
// the contract. Plain Kotlin, checked by embed/native/ios/vectors/envelope.json on the JVM.

package com.mieweb.pulse.kit.core

/** The contract this facade speaks (pulse-embed.d.ts, AD18). */
object PulseContract {
  /** The contract major. A client that speaks another is answered `contract.unsupported`. */
  const val MAJOR = 1

  /** The contract minor this facade answers (`info().contract.minor`; PulseKit.swift). */
  const val MINOR = 1

  /** The envelope version, always 1 in contract major 1. */
  const val ENVELOPE_VERSION = 1

  /**
   * The contract minor envelope.json was written for (its `contract` section). The router's default
   * method list is that minor's, so the vectors keep pinning PR1's rules (a minor-1 name is
   * `method.unsupported` there) while the facade passes [methods].
   */
  const val VECTORS_MINOR = 0

  /** Methods the facade answers itself in contract minor 0 (PR1). */
  @JvmField
  val nativeMethods: List<String> = listOf(
    "info", "configure", "prewarm", "open", "close", "isOpen", "pendingResults", "acknowledge",
    "logFile",
  )

  /** Every method contract minor 1 (PR2) adds, in envelope.json's `methods.minor1` order. */
  @JvmField
  val minor1Methods: List<String> = listOf(
    "setAccount", "listDrafts", "getDraft", "countDrafts", "renameDraft", "deleteDraft",
    "setDraftContext", "upload", "cancelUpload", "retireDraft", "dismissReceipt", "resumeOutbox",
    "usage", "listNamespaces", "purge", "respondHostRequest",
  )

  /** Minor 1's account and read methods the facade answers natively, from files. */
  @JvmField
  val readMethods: List<String> = listOf(
    "setAccount", "listDrafts", "getDraft", "countDrafts", "usage", "listNamespaces", "purge",
  )

  /** The host writes Pulse JS answers (§3 "JS"): forwarded as `pulse.cmd`. */
  @JvmField
  val forwardedMethods: List<String> = listOf(
    "renameDraft", "deleteDraft", "setDraftContext", "upload", "cancelUpload", "retireDraft",
    "dismissReceipt", "resumeOutbox",
  )

  /**
   * What this facade answers (`info().methods`): minor 0, then all of minor 1. The same list, in
   * the same order, as PulseKit.swift's `methods`.
   */
  @JvmField
  val methods: List<String> =
    nativeMethods + readMethods + forwardedMethods + listOf("respondHostRequest")

  /** The router's default: the vectors' minor-0 list (as PR2-D kept it in Swift). */
  @JvmField
  val vectorMethods: List<String> = nativeMethods

  /** Entries `open` accepts. */
  @JvmField
  val entries: List<String> = listOf("record", "edit", "export")
}

/**
 * `PulseErrorInfo` (pulse-embed.d.ts). [message] is English, for logs only. [extra] carries the
 * optional fields (`requestId`, `draftId`, `uploadId`, `details`, or any later one); it never
 * replaces the four fixed ones.
 */
data class PulseError(
  val code: String,
  val message: String,
  val recoverable: Boolean,
  val callId: String,
  val extra: Map<String, PulseJson> = emptyMap(),
) {
  /** `requestId` from [extra], when it is a string. */
  val requestId: String? get() = extra["requestId"]?.string

  /** The error object, as it goes inside a reply. */
  fun toJson(): PulseJson {
    val o = LinkedHashMap<String, PulseJson>()
    o["code"] = PulseJson.Str(code)
    o["message"] = PulseJson.Str(message)
    o["recoverable"] = PulseJson.Bool(recoverable)
    o["callId"] = PulseJson.Str(callId)
    for ((k, v) in extra) if (k !in o) o[k] = v
    return PulseJson.Obj(o)
  }

  /** Building and reading errors. */
  companion object {
    /** True when the same call may succeed later without a change by the person. */
    @JvmStatic
    fun isRecoverable(code: String): Boolean =
      code in setOf("busy", "timeout", "host.unavailable", "runtime.error", "upload.failed")

    /** An error whose [recoverable] follows [isRecoverable] unless given. */
    @JvmStatic
    @JvmOverloads
    fun of(
      code: String,
      message: String,
      callId: String,
      requestId: String? = null,
      recoverable: Boolean? = null,
      details: PulseJson? = null,
    ): PulseError {
      val extra = LinkedHashMap<String, PulseJson>()
      if (requestId != null) extra["requestId"] = PulseJson.Str(requestId)
      if (details != null) extra["details"] = details
      return PulseError(code, message, recoverable ?: isRecoverable(code), callId, extra)
    }

    /**
     * An error object as a reply carries it, or null when a fixed field is missing or of the wrong
     * type (Swift's Decodable). Optional fields that are present must be strings (`details`: any).
     */
    @JvmStatic
    fun fromJson(v: PulseJson): PulseError? {
      val o = v.obj ?: return null
      val code = o["code"]?.string ?: return null
      val message = o["message"]?.string ?: return null
      val recoverable = o["recoverable"]?.bool ?: return null
      val callId = o["callId"]?.string ?: return null
      val extra = LinkedHashMap<String, PulseJson>()
      for (key in listOf("requestId", "draftId", "uploadId")) {
        val f = o[key] ?: continue
        if (f == PulseJson.Null) continue
        extra[key] = PulseJson.Str(f.string ?: return null)
      }
      o["details"]?.let { if (it != PulseJson.Null) extra["details"] = it }
      return PulseError(code, message, recoverable, callId, extra)
    }
  }
}

/** A request envelope (§2.1). Unknown fields, at the top and inside [args], are ignored. */
data class PulseRequest(
  val v: Int,
  val callId: String,
  val method: String,
  val args: Map<String, PulseJson>,
  val client: Client? = null,
) {
  /** The calling client, when it said who it is. */
  data class Client(val contract: Contract?, val version: String?)

  /** The contract the client speaks. */
  data class Contract(val major: Int, val minor: Int?)
}

/** A reply envelope (§2.2). Every call gets exactly one; a Pulse error is `ok: false`. */
data class PulseReply(
  val v: Int,
  val callId: String,
  val ok: Boolean,
  val result: PulseJson?,
  val error: PulseError?,
) {
  /** The reply as compact JSON with sorted keys: `result` when ok (null for void), else `error`. */
  val serialized: String
    get() {
      val o = LinkedHashMap<String, PulseJson>()
      o["v"] = PulseJson.Integer(v.toLong())
      o["callId"] = PulseJson.Str(callId)
      o["ok"] = PulseJson.Bool(ok)
      if (ok) {
        o["result"] = result ?: PulseJson.Null
      } else {
        o["error"] = error?.toJson() ?: PulseJson.Null
      }
      return PulseJson.Obj(o).serialized
    }

  /** Building and reading replies. */
  companion object {
    /** `ok: true` with [result] (null for a void method). */
    @JvmStatic
    @JvmOverloads
    fun success(callId: String, result: PulseJson = PulseJson.Null): PulseReply =
      PulseReply(PulseContract.ENVELOPE_VERSION, callId, true, result, null)

    /** `ok: false` with [error]; the reply's callId is the error's. */
    @JvmStatic
    fun failure(error: PulseError): PulseReply =
      PulseReply(PulseContract.ENVELOPE_VERSION, error.callId, false, null, error)

    /** `ok: false` with a fresh error. */
    @JvmStatic
    @JvmOverloads
    fun failure(
      code: String,
      message: String,
      callId: String,
      requestId: String? = null,
    ): PulseReply = failure(PulseError.of(code, message, callId, requestId))

    /**
     * A reply envelope from text (Pulse JS's `pulse.reply`), or null when it isn't one. A `null`
     * result is [PulseJson.Null], not a missing one; unknown fields are ignored.
     */
    @JvmStatic
    fun parse(text: String): PulseReply? {
      val o = PulseJson.parse(text)?.obj ?: return null
      val v = o["v"]?.integer ?: return null
      if (v < Int.MIN_VALUE || v > Int.MAX_VALUE) return null
      val callId = o["callId"]?.string ?: return null
      val ok = o["ok"]?.bool ?: return null
      val result = o["result"]
      val error = when (val e = o["error"]) {
        null, PulseJson.Null -> null
        else -> PulseError.fromJson(e) ?: return null
      }
      return PulseReply(v.toInt(), callId, ok, result, error)
    }
  }
}

/** An event envelope (§2.3). */
data class PulseEvent(val name: String, val payload: PulseJson) {
  /** The event as compact JSON with sorted keys. */
  val serialized: String
    get() = PulseJson.obj(
      "v" to PulseJson.Integer(PulseContract.ENVELOPE_VERSION.toLong()),
      "name" to PulseJson.Str(name),
      "payload" to payload,
    ).serialized
}
