// Mirrors embed/native/ios/PulseKitEnvelope.swift (`PulseInboxEntry`, `PulseInboxOrder`), the
// pure half of PulseKitInbox.swift. native-bridge.md §6.2. Checked by envelope.json's `inbox` and
// `acknowledge` sections on the JVM. The facade lists the folder and deletes the files.

package com.mieweb.pulse.kit.core

/**
 * One file in `results/`: its name and modification time in seconds since 1970 (Android's
 * `File.lastModified()` is milliseconds: divide by 1000.0).
 */
data class PulseInboxEntry(val name: String, val modifiedSeconds: Double)

/** The results inbox's rules. */
object PulseInboxRules {
  /** The inbox folder under the namespace's documents root. */
  const val FOLDER = "results"

  /**
   * Request ids of the result files, oldest first (`pendingResults`): every `<id>.json` except
   * `<id>.project.json` (the project document next to a file-mode export), skipping names that
   * aren't plain ids (a `.part` write in progress never ends in `.json`). Ties go by name, so the
   * order is stable.
   */
  @JvmStatic
  fun pending(entries: List<PulseInboxEntry>): List<String> =
    entries
      .filter { it.name.endsWith(".json") && !it.name.endsWith(".project.json") }
      .map { it.name.dropLast(5) to it.modifiedSeconds }
      .filter { PulseValidation.isPlainName(it.first) }
      .sortedWith(compareBy<Pair<String, Double>> { it.second }.thenBy { it.first })
      .map { it.first }

  /** The file names `acknowledge(requestId)` deletes. */
  @JvmStatic
  fun acknowledgeFiles(requestId: String): List<String> =
    listOf(".json", ".mp4", ".project.json").map { requestId + it }

  /** The result file for [requestId]. */
  @JvmStatic
  fun resultFile(requestId: String): String = "$requestId.json"
}
