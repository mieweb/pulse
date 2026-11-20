// Mirrors embed/native/ios/PulseKitEnvelope.swift (`PulseRouter.route`) and the native/forwarded
// split in PulseKit.swift's `handle`. native-bridge.md §2.1 and §3. Checked by envelope.json's
// `requests` section on the JVM.

package com.mieweb.pulse.kit.core

/** What happens to one request envelope. */
sealed class PulseRoute {
  /** The facade answers this request itself. */
  data class Native(val request: PulseRequest) : PulseRoute() {
    /** The method to answer. */
    val method: String get() = request.method

    /** Its arguments (`{}` when the request had none). */
    val args: Map<String, PulseJson> get() = request.args
  }

  /** A host write Pulse JS answers: forwarded as one `pulse.cmd`, answered by one `pulse.reply`. */
  data class Forward(val request: PulseRequest) : PulseRoute() {
    /** The method to forward. */
    val method: String get() = request.method

    /** Its arguments (`{}` when the request had none). */
    val args: Map<String, PulseJson> get() = request.args
  }

  /** The request ends here with this reply. */
  data class Reply(val reply: PulseReply) : PulseRoute() {
    /** The reply's error (a routed reply is always one). */
    val error: PulseError? get() = reply.error
  }
}

/** The router: the same checks, in the same order, as Swift's `PulseRouter.route`. */
object PulseRouter {
  /**
   * Decide what happens to one request envelope.
   *
   * Checks, in order: the text is a JSON object; `callId` (else a reply with `callId: ""`); `v`;
   * `client.contract.major` (a mismatch wins over everything after the callId); `method`; `args`
   * (null or missing is `{}`, anything but an object is `invalid_options`); [methods] lists the
   * method (else `method.unsupported`); [supported] (when false, every method but `info` is
   * `unsupported`). A listed method in [forwarded] is [PulseRoute.Forward], any other
   * [PulseRoute.Native].
   *
   * [methods] defaults to the vectors' minor-0 list ([PulseContract.vectorMethods]); the facade
   * passes [PulseContract.methods].
   */
  @JvmStatic
  @JvmOverloads
  fun route(
    text: String,
    supported: Boolean = true,
    methods: List<String> = PulseContract.vectorMethods,
    forwarded: List<String> = PulseContract.forwardedMethods,
  ): PulseRoute {
    val top = PulseJson.parse(text)?.obj
      ?: return reply("invalid_options", "The request isn't a JSON object.", "")
    val callId = top["callId"]?.string
    if (callId.isNullOrEmpty()) return reply("invalid_options", "The request has no callId.", "")
    fun fail(code: String, message: String) = reply(code, message, callId)

    val v = top["v"]?.integer
      ?: return fail("invalid_options", "The request has no envelope version (v).")
    if (v != PulseContract.ENVELOPE_VERSION.toLong()) {
      return fail(
        "contract.unsupported",
        "Envelope version $v isn't supported; this facade speaks " +
          "${PulseContract.ENVELOPE_VERSION}.",
      )
    }
    var client: PulseRequest.Client? = null
    val c = top["client"]
    if (c != null) {
      if (c.obj == null) return fail("invalid_options", "client must be an object.")
      var contract: PulseRequest.Contract? = null
      val k = c["contract"]
      if (k != null) {
        val major = k["major"]?.integer
          ?: return fail("invalid_options", "client.contract.major must be a number.")
        if (major != PulseContract.MAJOR.toLong()) {
          return fail(
            "contract.unsupported",
            "The client speaks contract major $major; this facade speaks ${PulseContract.MAJOR}.",
          )
        }
        contract = PulseRequest.Contract(major.toInt(), k["minor"]?.integer?.let { clampInt(it) })
      }
      client = PulseRequest.Client(contract, c["version"]?.string)
    }
    val method = top["method"]?.string
    if (method.isNullOrEmpty()) return fail("invalid_options", "The request has no method.")
    val args: Map<String, PulseJson> = when (val a = top["args"]) {
      null, PulseJson.Null -> emptyMap()
      is PulseJson.Obj -> a.fields
      else -> return fail("invalid_options", "args must be an object.")
    }
    if (method !in methods) {
      return fail("method.unsupported", "This PulseKit doesn't answer $method.")
    }
    if (!supported && method != "info") {
      return fail("unsupported", "Pulse doesn't run on this device.")
    }
    val request = PulseRequest(v.toInt(), callId, method, args, client)
    return if (method in forwarded) PulseRoute.Forward(request) else PulseRoute.Native(request)
  }

  private fun reply(code: String, message: String, callId: String): PulseRoute =
    PulseRoute.Reply(PulseReply.failure(code, message, callId))

  private fun clampInt(n: Long): Int =
    n.coerceIn(Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong()).toInt()
}
