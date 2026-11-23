// Mirrors embed/native/ios/PulseKitAccounts.swift (`PulseKitAccounts`): accounts and namespaces
// (native-bridge.md §4, pulse-schema.md §6, C4, AD12). The namespace math, the argument checks and
// account.json's shape are core/PulseNamespace.kt (vector-checked); this file does the folders.

package com.mieweb.pulse.kit

import com.mieweb.pulse.kit.core.PulseAccountArgs
import com.mieweb.pulse.kit.core.PulseAccountChoice
import com.mieweb.pulse.kit.core.PulseAccountFile
import com.mieweb.pulse.kit.core.PulseCatalogReader
import com.mieweb.pulse.kit.core.PulseError
import com.mieweb.pulse.kit.core.PulseJson
import com.mieweb.pulse.kit.core.PulseNetworkView
import java.io.File
import java.io.IOException

/** What `setAccount` did. */
internal sealed class AccountOutcome {
  /** `setAccount(null)`: no active namespace. */
  object Cleared : AccountOutcome()

  /** The same namespace again: nothing changed. */
  data class Unchanged(val namespace: String) : AccountOutcome()

  /** Another namespace is active now. */
  data class Switched(val namespace: String) : AccountOutcome()

  /**
   * Switched, but Pulse's runtime is bound to another namespace: native reads answer for this one,
   * while open (and anything Pulse JS answers) is `restart_required` until the app restarts.
   */
  data class RestartRequired(val namespace: String) : AccountOutcome()

  /** Refused with this error. */
  data class Failed(val error: PulseError) : AccountOutcome()
}

/**
 * The signed-in account and what `setAccount`, `listNamespaces` and the data calls see of it.
 * Main thread only (PulseKit's transport runs there). Every signed-in person gets a namespace of
 * their own: a folder with its own library, catalog, results and media.
 */
internal class PulseKitAccounts(private val storage: PulseKitStorage) {
  /** The active account: its namespace and its account.json. */
  data class Active(val namespace: String, val file: PulseAccountFile)

  /**
   * Null before the first `setAccount` in this process and after `setAccount(null)`: data calls
   * then fail with `no_account`.
   */
  var active: Active? = null
    private set

  /** The active namespace, or null. */
  val namespace: String? get() = active?.namespace

  /**
   * `setAccount(account | null)`. `{}` is the wire form of null.
   *
   * - A flow is open → `busy`: the open flow writes into the active namespace.
   * - null → no active namespace (data calls → `no_account`); the runtime keeps its folders.
   * - The same namespace → a no-op (a new label is still kept: listNamespaces shows it).
   * - Otherwise it switches: folders, `account.json` (createdAt kept, lastUsedAt now).
   * - When Pulse's runtime is bound to another namespace ([bound]), it still switches, so native
   *   reads (the catalog) answer for the new person and never show the last person's drafts, but
   *   the outcome is [AccountOutcome.RestartRequired]: the runtime's storage roots and open
   *   database are fixed for its life (v1; X10 lifts this). Signing back in to the bound
   *   namespace is always fine.
   */
  fun set(
    args: Map<String, PulseJson>,
    hostId: String,
    flowOpen: Boolean,
    bound: String?,
    callId: String,
    now: Long = System.currentTimeMillis(),
  ): AccountOutcome {
    fun fail(code: String, message: String) =
      AccountOutcome.Failed(PulseError.of(code, message, callId))

    if (flowOpen) return fail("busy", "Pulse is open; change the account after it closes.")
    val account = when (val choice = PulseAccountArgs.parse(args, hostId, callId)) {
      is PulseAccountChoice.Invalid -> return AccountOutcome.Failed(choice.error)
      PulseAccountChoice.Cleared -> {
        active = null
        return AccountOutcome.Cleared
      }
      is PulseAccountChoice.Account -> choice
    }
    val ns = account.namespace
    val current = active
    if (current != null && ns == current.namespace) {
      if (account.label != null && account.label != current.file.label) {
        try {
          touch(label = account.label, setLabel = true, now = now)
        } catch (e: IOException) {
          pulseKitLog("setAccount $callId: couldn't keep the new label: ${e.message}")
        }
      }
      if (bound != null && bound != ns) return AccountOutcome.RestartRequired(ns)
      return AccountOutcome.Unchanged(ns)
    }
    val roots = try {
      storage.roots(ns)
    } catch (e: IOException) {
      return fail("unknown", "Pulse's folders aren't available: ${e.message}")
    }
    val previous = readFile(roots.documents)
    val file = PulseAccountFile(
      hostId = hostId,
      serverOrigin = account.serverOrigin,
      label = account.label,
      createdAt = previous?.createdAt ?: now,
      lastUsedAt = now,
    )
    try {
      writeFile(file, roots.documents)
    } catch (e: IOException) {
      return fail("unknown", "Pulse couldn't write account.json: ${e.message}")
    }
    active = Active(ns, file)
    if (bound != null && bound != ns) return AccountOutcome.RestartRequired(ns)
    return AccountOutcome.Switched(ns)
  }

  /**
   * Make sure the active namespace's folders and `account.json` exist (a purge of the active
   * namespace removes them; the person stays signed in) and return its roots; null when signed
   * out.
   */
  @Throws(IOException::class)
  fun activeRoots(): PulseKitRoots? {
    val a = active ?: return null
    val roots = storage.roots(a.namespace)
    if (readFile(roots.documents) == null) writeFile(a.file, roots.documents)
    return roots
  }

  /**
   * Record that the active namespace was used now (an open), and keep [label] when [setLabel]
   * (Swift's `String??`).
   */
  @Throws(IOException::class)
  fun touch(
    label: String? = null,
    setLabel: Boolean = false,
    now: Long = System.currentTimeMillis(),
  ): Boolean {
    val a = active ?: return false
    val roots = activeRoots() ?: return false
    val file = a.file.copy(lastUsedAt = now, label = if (setLabel) label else a.file.label)
    writeFile(file, roots.documents)
    active = a.copy(file = file)
    return true
  }

  /**
   * `listNamespaces()`: every namespace folder with an `account.json`, plus PR1's `<hostId>-local`
   * folders (no account.json; reported so the host can see and clean them up). In name order;
   * oldest use first is the host's business.
   */
  fun list(net: PulseNetworkView): List<PulseJson> =
    storage.namespaceNames().mapNotNull { name ->
      val documents = storage.documents(name)
      val file = readFile(documents)
      val local = file == null && name.endsWith(PulseKitStorage.LOCAL_SUFFIX)
      if (file == null && !local) return@mapNotNull null
      val catalog = PulseKitStorage.readCatalog(documents)
      val unsent = if (catalog != null) {
        PulseCatalogReader.counts(catalog, net).unsent
      } else {
        PulseKitStorage.draftFolders(documents)
      }
      val o = LinkedHashMap<String, PulseJson>()
      o["namespace"] = PulseJson.Str(name)
      o["hostId"] =
        PulseJson.Str(file?.hostId ?: name.dropLast(PulseKitStorage.LOCAL_SUFFIX.length))
      o["serverOrigin"] = PulseJson.Str(file?.serverOrigin ?: "")
      o["bytes"] = PulseJson.Integer(storage.bytes(name))
      o["unsent"] = PulseJson.Integer(unsent.toLong())
      o["lastUsedAt"] =
        PulseJson.Integer(file?.lastUsedAt ?: PulseKitStorage.modifiedAt(documents))
      o["active"] = PulseJson.Bool(name == namespace)
      file?.label?.let { o["label"] = PulseJson.Str(it) }
      PulseJson.Obj(o)
    }

  /** account.json files and PR1's `-local` folders. */
  companion object {
    /** account.json under [documents], or null when missing or not one. */
    fun readFile(documents: File): PulseAccountFile? =
      PulseAccountFile.parse(PulseKitStorage.readText(File(documents, PulseAccountFile.NAME)))

    /** Write account.json under [documents] atomically (sorted keys, as Swift writes it). */
    @Throws(IOException::class)
    fun writeFile(file: PulseAccountFile, documents: File) {
      PulseKitStorage.writeAtomically(
        file.serialized.toByteArray(Charsets.UTF_8),
        File(documents, PulseAccountFile.NAME),
      )
    }

    /**
     * PR1 kept everything in `<hostId>-local`. It is never adopted into a signed-in account (a
     * shared phone could hand one person's drafts to another): when empty it is deleted; when
     * not, it stays, listed by listNamespaces, for the host's stale-namespace cleanup (purge).
     * [except] is a namespace the runtime is bound to, which is never touched. Returns the
     * namespaces removed.
     */
    fun removeEmptyLocalNamespaces(storage: PulseKitStorage, except: String?): List<String> {
      val removed = mutableListOf<String>()
      for (name in storage.namespaceNames()) {
        if (!name.endsWith(PulseKitStorage.LOCAL_SUFFIX) || name == except) continue
        val documents = storage.documents(name)
        if (readFile(documents) != null || !PulseKitStorage.isEmpty(documents)) continue
        try {
          storage.remove(name)
          removed.add(name)
        } catch (e: IOException) {
          pulseKitLog("couldn't remove the empty namespace $name: ${e.message}")
        }
      }
      return removed
    }
  }
}
