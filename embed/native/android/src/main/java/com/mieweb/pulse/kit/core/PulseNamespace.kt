// Mirrors embed/native/ios/PulseKitAccounts.swift (`PulseOrigin`, `PulseNamespace.account`,
// `PulseAccountFile`, the argument half of `PulseKitAccounts.set`) and PulseKitEnvelope.swift
// (`PulseNamespace.sanitise`, `local`). native-bridge.md §4 and §6.4. Checked on the JVM by
// embed/native/ios/namespace-vectors.json and envelope.json's `namespace` section:
//
//   origin    = lowercase(scheme + "://" + host) + (non-default port ? ":" + port : "")
//   namespace = hostId + "-" + lowercaseHex(SHA256(UTF8(origin + "\n" + userId)))[0..<16]

package com.mieweb.pulse.kit.core

import java.security.MessageDigest

/**
 * The origin rule. Strict on purpose, so Kotlin, Swift and the Node vectors can't disagree: http or
 * https, an ASCII host name or IPv4 address, an optional port 1–65535 (dropped when it is the
 * scheme's default), and whatever path, query or fragment follows is ignored. Credentials, IPv6
 * literals, non-ASCII hosts (pass them punycoded), an empty port and surrounding spaces are
 * refused. It works on the UTF-8 bytes, as Swift's does.
 */
object PulseOrigin {
  /** The normalised origin, or null when [serverOrigin] isn't one this rule accepts. */
  @JvmStatic
  fun normalise(serverOrigin: String): String? {
    val ascii = serverOrigin.toByteArray(Charsets.UTF_8)
    val sep = find(ascii, "://".toByteArray(Charsets.US_ASCII)) ?: return null
    if (sep == 0 || !isLetter(ascii[0])) return null
    for (k in 0 until sep) {
      val b = ascii[k]
      if (!(isLetter(b) || isDigit(b) || b == '+'.code.toByte() || b == '.'.code.toByte() ||
          b == '-'.code.toByte())
      ) {
        return null
      }
    }
    val scheme = String(ascii, 0, sep, Charsets.US_ASCII).lowercase()
    if (scheme != "http" && scheme != "https") return null
    var end = sep + 3
    while (end < ascii.size && !isOneOf(ascii[end], "/?#")) end++
    val authorityStart = sep + 3
    var hostEnd = end
    var port: Int? = null
    var colon = -1
    for (k in authorityStart until end) {
      if (ascii[k] == ':'.code.toByte()) {
        colon = k
        break
      }
    }
    if (colon >= 0) {
      hostEnd = colon
      val digits = colon + 1 until end
      val count = end - colon - 1
      if (count !in 1..5 || digits.any { !isDigit(ascii[it]) }) return null
      val p = String(ascii, colon + 1, count, Charsets.US_ASCII).toInt()
      if (p !in 1..65535) return null
      port = p
    }
    if (hostEnd == authorityStart) return null
    var hasAlnum = false
    for (k in authorityStart until hostEnd) {
      val b = ascii[k]
      val alnum = isLetter(b) || isDigit(b)
      if (!(alnum || b == '.'.code.toByte() || b == '-'.code.toByte())) return null
      if (alnum) hasAlnum = true
    }
    if (!hasAlnum) return null
    val host =
      String(ascii, authorityStart, hostEnd - authorityStart, Charsets.US_ASCII).lowercase()
    if (port == (if (scheme == "http") 80 else 443)) port = null
    return scheme + "://" + host + (port?.let { ":$it" } ?: "")
  }

  private fun isLetter(b: Byte): Boolean = (b in 'a'.code..'z'.code) || (b in 'A'.code..'Z'.code)

  private fun isDigit(b: Byte): Boolean = b in '0'.code..'9'.code

  private fun isOneOf(b: Byte, chars: String): Boolean = chars.any { it.code.toByte() == b }

  private fun find(hay: ByteArray, needle: ByteArray): Int? {
    if (hay.size < needle.size) return null
    outer@ for (i in 0..(hay.size - needle.size)) {
      for (j in needle.indices) if (hay[i + j] != needle[j]) continue@outer
      return i
    }
    return null
  }
}

/** Namespaces: PR1's `<hostId>-local` and PR2's per-account ones. */
object PulseNamespace {
  /** PR1's namespace suffix (no accounts): `<hostId>-local`. */
  const val LOCAL_SUFFIX = "-local"

  /** `ConfigureOptions.hostId`: 1–40 of `[a-z0-9.-]` with at least one letter or digit. */
  @JvmStatic
  fun isValidHostId(s: String): Boolean = PulseValidation.isValidHostId(s)

  /**
   * The default hostId from a package name (iOS: the bundle id): lowercased, every code point
   * outside `[a-z0-9.-]` becomes `-`, at most 40 characters, no leading or trailing dot or dash;
   * `host` when nothing valid is left.
   */
  @JvmStatic
  fun sanitise(packageName: String): String {
    val lower = packageName.lowercase()
    val mapped = StringBuilder()
    var i = 0
    while (i < lower.length) {
      val cp = lower.codePointAt(i)
      val keep = cp < 0x80 && PulseValidation.isHostIdChar(cp.toChar())
      mapped.append(if (keep) cp.toChar() else '-')
      i += Character.charCount(cp)
    }
    val trimmed = mapped.toString().take(PulseValidation.HOST_ID_MAX).trim('.', '-')
    return if (isValidHostId(trimmed)) trimmed else "host"
  }

  /** PR1 has no accounts: everything lives in `<hostId>-local` until PR2's setAccount. */
  @JvmStatic
  fun local(hostId: String): String = hostId + LOCAL_SUFFIX

  /** `<hostId>-<first 16 hex of SHA-256(origin + "\n" + userId)>`; [origin] is normalised. */
  @JvmStatic
  fun account(hostId: String, origin: String, userId: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
      .digest((origin + "\n" + userId).toByteArray(Charsets.UTF_8))
    val hex = StringBuilder()
    for (b in digest) {
      val v = b.toInt() and 0xff
      hex.append("0123456789abcdef"[v shr 4]).append("0123456789abcdef"[v and 0xf])
    }
    return hostId + "-" + hex.substring(0, 16)
  }
}

/** What `setAccount`'s arguments ask for, after the checks. */
sealed class PulseAccountChoice {
  /** `setAccount(null)` (`{}` or every field null): no active namespace. */
  object Cleared : PulseAccountChoice()

  /** An account: its namespace, the normalised origin, and the label when one was given. */
  data class Account(val namespace: String, val serverOrigin: String, val label: String?) :
    PulseAccountChoice()

  /** Refused with `invalid_options`. */
  data class Invalid(val error: PulseError) : PulseAccountChoice()
}

/** The pure half of `setAccount` (PulseKitAccounts.swift `set`). */
object PulseAccountArgs {
  /**
   * Read `setAccount`'s [args] for [hostId]. The facade checks `busy` (a flow is open) before
   * this, and does the folders, `account.json` and `restart_required` after it.
   */
  @JvmStatic
  fun parse(args: Map<String, PulseJson>, hostId: String, callId: String): PulseAccountChoice {
    fun bad(message: String) =
      PulseAccountChoice.Invalid(PulseError.of("invalid_options", message, callId))

    if (args.values.all { it == PulseJson.Null }) return PulseAccountChoice.Cleared
    val serverOrigin = args["serverOrigin"]?.string
    if (serverOrigin.isNullOrEmpty()) return bad("serverOrigin must be a non-empty string.")
    val origin = PulseOrigin.normalise(serverOrigin)
      ?: return bad(
        "serverOrigin must be an http or https origin with an ASCII host, such as " +
          "https://example.org.",
      )
    val userId = args["userId"]?.string
    if (userId.isNullOrEmpty()) return bad("userId must be a non-empty string.")
    var label: String? = null
    val l = args["label"]
    if (l != null && l != PulseJson.Null) label = l.string ?: return bad("label must be a string.")
    return PulseAccountChoice.Account(PulseNamespace.account(hostId, origin, userId), origin, label)
  }
}

/**
 * `account.json` (native-bridge.md §6.4). It never holds the userId: the namespace is a hash so
 * that a folder name doesn't say whose it is.
 */
data class PulseAccountFile(
  val hostId: String,
  val serverOrigin: String,
  val label: String?,
  val createdAt: Long,
  val lastUsedAt: Long,
) {
  /** The file's object; `label` only when there is one. */
  fun toJson(): PulseJson {
    val o = LinkedHashMap<String, PulseJson>()
    o["hostId"] = PulseJson.Str(hostId)
    o["serverOrigin"] = PulseJson.Str(serverOrigin)
    if (label != null) o["label"] = PulseJson.Str(label)
    o["createdAt"] = PulseJson.Integer(createdAt)
    o["lastUsedAt"] = PulseJson.Integer(lastUsedAt)
    return PulseJson.Obj(o)
  }

  /** The file's text: compact, sorted keys (Swift writes the same). */
  val serialized: String get() = toJson().serialized

  /** Reading the file. */
  companion object {
    /** The file's name in a namespace's documents root. */
    const val NAME = "account.json"

    /** The file from its text, or null when it isn't one. Unknown fields are ignored. */
    @JvmStatic
    fun parse(text: String?): PulseAccountFile? {
      val o = text?.let { PulseJson.parse(it) }?.obj ?: return null
      val hostId = o["hostId"]?.string ?: return null
      val serverOrigin = o["serverOrigin"]?.string ?: return null
      val label = when (val l = o["label"]) {
        null, PulseJson.Null -> null
        else -> l.string ?: return null
      }
      val createdAt = o["createdAt"]?.integer ?: return null
      val lastUsedAt = o["lastUsedAt"]?.integer ?: return null
      return PulseAccountFile(hostId, serverOrigin, label, createdAt, lastUsedAt)
    }
  }
}
