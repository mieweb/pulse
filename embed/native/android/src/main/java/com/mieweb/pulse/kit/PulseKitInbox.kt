// Mirrors embed/native/ios/PulseKitInbox.swift (PulseKitRoots, PulseKitInbox) and the fallback
// results in PulseKit.swift (`interrupted`, `ended`, `failed`): the durable results inbox
// (native-bridge.md §6.2, AD15). The ordering and file-name rules are core/PulseInboxRules.kt.

package com.mieweb.pulse.kit

import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import com.mieweb.pulse.kit.core.PulseError
import com.mieweb.pulse.kit.core.PulseInboxEntry
import com.mieweb.pulse.kit.core.PulseInboxRules
import com.mieweb.pulse.kit.core.PulseJson
import com.mieweb.pulse.kit.core.PulseValidation
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID

/**
 * Where one namespace keeps its files (native-bridge.md §6), inside the host's sandbox:
 * `filesDir/PulseKit/<ns>` for the library and `cacheDir/PulseKit/<ns>` for caches
 * (PulseKitStorage.kt), never a folder the host's own code or the user's file manager writes.
 *
 * @property models Captions models, shared by every namespace (§6.5).
 */
internal class PulseKitRoots(
  val namespace: String,
  val documents: File,
  val caches: File,
  val models: File,
) {
  /** The results inbox, `results/`. */
  val inbox: PulseKitInbox get() = PulseKitInbox(File(documents, PulseInboxRules.FOLDER))

  /** `logs/pulse.log`, which Pulse JS writes (§6.3). */
  val logFile: File get() = File(documents, "logs/pulse.log")
}

/**
 * The durable results inbox (§6.2, AD15). Pulse JS writes `results/<requestId>.json` before it
 * says a flow ended, so a lost message or a killed process loses nothing. The facade reads it, and
 * writes a result itself only when a flow ends without one (a fatal error, a forced close, its
 * screen gone).
 */
internal class PulseKitInbox(val dir: File) {
  /** Every unacknowledged result, oldest first. A file that can't be parsed is skipped. */
  fun pending(): List<PulseJson> {
    val names = dir.list() ?: return emptyList()
    val entries = names.map { PulseInboxEntry(it, File(dir, it).lastModified() / 1000.0) }
    return PulseInboxRules.pending(entries).mapNotNull { read(it) }
  }

  /** The result for [requestId], or null when there is none or it can't be parsed. */
  fun read(requestId: String): PulseJson? {
    if (!PulseValidation.isPlainName(requestId)) return null
    val text = PulseKitStorage.readText(File(dir, PulseInboxRules.resultFile(requestId)))
      ?: return null
    val value = PulseJson.parse(text) ?: return null
    return if (value.obj != null) value else null
  }

  /** Delete a result and its files. An unknown id is a no-op. */
  fun acknowledge(requestId: String) {
    if (!PulseValidation.isPlainName(requestId)) return
    for (name in PulseInboxRules.acknowledgeFiles(requestId)) File(dir, name).delete()
  }

  /**
   * Write [result] unless Pulse JS already wrote one: a temp file of the facade's own
   * (`<id>.json.native-<uuid>.part`, never JS's `<id>.json.part`), then a hard link to the
   * result's name, which fails if the name exists, then the temp file goes. So a forced close
   * that races Pulse JS writing its real result can't delete or overwrite JS's file: JS's result
   * wins, and a result JS writes later replaces this one. (Swift moves the temp file, which also
   * refuses an existing name; `rename` on Android would replace it.)
   */
  fun writeIfAbsent(result: PulseJson, requestId: String) {
    if (!PulseValidation.isPlainName(requestId)) return
    val dest = File(dir, PulseInboxRules.resultFile(requestId))
    if (dest.exists()) return
    val part = File(dir, "${dest.name}.native-${UUID.randomUUID().toString().lowercase()}.part")
    try {
      PulseKitStorage.makeDirs(dir)
      FileOutputStream(part).use { out ->
        out.write(result.serialized.toByteArray(Charsets.UTF_8))
        out.flush()
        out.fd.sync()
      }
      try {
        Os.link(part.path, dest.path)
      } catch (e: ErrnoException) {
        when (e.errno) {
          OsConstants.EEXIST -> Unit
          // App storage refuses hard links on many devices (the S24, Android 16: EACCES). Fall back
          // to a move, still never over an existing name; the window between the check and the
          // move is the only place a result Pulse JS writes at that instant could be replaced.
          OsConstants.EACCES, OsConstants.EPERM ->
            if (!dest.exists() && !part.renameTo(dest)) throw IOException("couldn't move $part into place")
          else -> throw IOException("link failed: errno ${e.errno}")
        }
      }
    } catch (e: IOException) {
      pulseKitLog("couldn't write the result for $requestId: ${e.message}")
    } finally {
      part.delete()
    }
  }
}

/**
 * The facade's own results, for a flow that ended without one from Pulse JS (PulseKit.swift
 * `interrupted`, `ended`, `failed`). Only a fallback: if Pulse JS writes its own result for the
 * requestId later, that file replaces this one and a second `flowResult` follows; the host acts on
 * the later one (vectors/README.md).
 */
internal object PulseKitResults {
  /** The draft an open request names: `draftId` (edit, export) or `draft.continue` (record). */
  fun draftId(request: Map<String, PulseJson>): String? =
    request["draftId"]?.string ?: request["draft"]?.get("continue")?.string

  /**
   * The result for a flow that ended before Pulse JS said so (a forced close with reason `host`,
   * its screen gone with reason `interrupted`). With a take on screen (the last `pulse.ui`
   * hasTake) and a known draft it is `closed`, as `close()` promises; otherwise `canceled`,
   * because `closed` needs a draftId the facade doesn't know for a new recording.
   */
  fun interrupted(
    request: Map<String, PulseJson>,
    requestId: String,
    hasTake: Boolean,
    reason: String,
  ): PulseJson {
    val draftId = draftId(request)
    if (hasTake && draftId != null) {
      return ended(
        request,
        requestId,
        "closed",
        mapOf(
          "reason" to PulseJson.Str(reason),
          "draftId" to PulseJson.Str(draftId),
          "stage" to PulseJson.Str("recorded"),
        ),
      )
    }
    return ended(request, requestId, "canceled", mapOf("reason" to PulseJson.Str(reason)))
  }

  /** `failed` with a `runtime.error` (a fatal JS error, or the embed root couldn't start). */
  fun failed(
    request: Map<String, PulseJson>,
    requestId: String,
    callId: String,
    message: String,
    code: String = "runtime.error",
  ): PulseJson {
    val error = PulseError.of(code, message, callId, requestId)
    return ended(request, requestId, "failed", mapOf("error" to error.toJson()))
  }

  /** A result the facade writes itself, when the flow ended without one from Pulse JS. */
  fun ended(
    request: Map<String, PulseJson>,
    requestId: String,
    status: String,
    extra: Map<String, PulseJson>,
  ): PulseJson {
    val o = LinkedHashMap<String, PulseJson>()
    o["status"] = PulseJson.Str(status)
    o["requestId"] = PulseJson.Str(requestId)
    o["entry"] = request["entry"] ?: PulseJson.Null
    o["endedOn"] = PulseJson.Null
    o["stage"] = PulseJson.Str("none")
    o["context"] = request["context"] ?: PulseJson.Null
    o["endedAt"] = PulseJson.Integer(System.currentTimeMillis())
    draftId(request)?.let { o["draftId"] = PulseJson.Str(it) }
    o.putAll(extra)
    return PulseJson.Obj(o)
  }
}
