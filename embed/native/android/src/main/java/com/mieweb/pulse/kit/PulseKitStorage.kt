// Mirrors embed/native/ios/PulseKitStorage.swift: where every namespace lives on disk, and the
// rules for those folders (pulse-schema.md §6, native-bridge.md §6.5, C4, C5).

package com.mieweb.pulse.kit

import android.content.Context
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import com.mieweb.pulse.kit.core.PulseCatalogReader
import com.mieweb.pulse.kit.core.PulseInboxRules
import com.mieweb.pulse.kit.core.PulseNamespace
import com.mieweb.pulse.kit.core.PulseValidation
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * Pulse's folders inside the host's sandbox:
 *
 * ```
 * filesDir/PulseKit/<ns>/            documents: SQLite, drafts, results, catalog.json, account.json,
 *                                    logs
 * cacheDir/PulseKit/<ns>/            caches
 * filesDir/PulseKit/.shared/models/  captions models, shared by every namespace
 * ```
 *
 * Android differences from iOS (PR4-SPEC "Android differences", spike S1):
 * - Under `filesDir`, not `noBackupFilesDir`: expo-file-system's FilePermissionService grants
 *   writes only inside filesDir and cacheDir, and S1 saw takes silently dropped under no_backup.
 *   So these folders are NOT excluded from backups by PulseKit: a library can't change the
 *   host's Auto Backup rules. The host excludes `PulseKit/` in its own `fullBackupContent` /
 *   `dataExtractionRules` (PR5's docs); iOS sets the exclusion itself.
 * - Android has no file-protection classes: a locked phone can read these files (iOS:
 *   completeUntilFirstUserAuthentication), which is what a background upload needs anyway.
 * - The facade never opens SQLite: it deletes folders only after Pulse JS has let go of the
 *   library (`releaseLibrary`, PulseKit.kt).
 */
internal class PulseKitStorage(context: Context) {
  private val app: Context = context.applicationContext ?: context

  /** `filesDir/PulseKit`. */
  val libraryRoot: File get() = File(app.filesDir, ROOT)

  /** `cacheDir/PulseKit`. */
  val cachesRoot: File get() = File(app.cacheDir, ROOT)

  /** `filesDir/PulseKit/.shared`, which holds the captions models. */
  val sharedRoot: File get() = File(libraryRoot, SHARED)

  /** A namespace's documents root, without creating it. */
  fun documents(namespace: String): File = File(libraryRoot, namespace)

  /** The roots of [namespace], created when missing. */
  @Throws(IOException::class)
  fun roots(namespace: String): PulseKitRoots {
    if (!isNamespaceName(namespace)) throw IOException("$namespace isn't a namespace.")
    val roots = PulseKitRoots(
      namespace = namespace,
      documents = File(libraryRoot, namespace),
      caches = File(cachesRoot, namespace),
      models = File(sharedRoot, "models"),
    )
    for (dir in listOf(roots.documents, roots.caches, roots.models)) makeDirs(dir)
    return roots
  }

  /** Both roots of a namespace together, in bytes (allocated size where the file system says). */
  fun bytes(namespace: String): Long {
    if (!isNamespaceName(namespace)) return 0
    return size(File(libraryRoot, namespace)) + size(File(cachesRoot, namespace))
  }

  /**
   * The namespace folders under `filesDir/PulseKit`, by name; `.shared` and other dot-names are
   * not namespaces.
   */
  fun namespaceNames(): List<String> {
    val names = libraryRoot.list() ?: return emptyList()
    return names.filter { isNamespaceName(it) && File(libraryRoot, it).isDirectory }.sorted()
  }

  /**
   * Delete both roots of [namespace]. The shared models go too when no namespace is left, and
   * then the empty `PulseKit` folders themselves, so a purged phone holds nothing of Pulse's.
   */
  @Throws(IOException::class)
  fun remove(namespace: String) {
    if (!isNamespaceName(namespace)) return
    for (dir in listOf(File(libraryRoot, namespace), File(cachesRoot, namespace))) {
      if (dir.exists() && !dir.deleteRecursively()) throw IOException("couldn't delete $dir")
    }
    if (namespaceNames().isNotEmpty()) return
    val shared = sharedRoot
    if (shared.exists() && !shared.deleteRecursively()) throw IOException("couldn't delete $shared")
    for (root in listOf(libraryRoot, cachesRoot)) {
      if (root.list()?.isEmpty() == true) root.delete()
    }
  }

  /** Paths, names and file helpers that need no context. */
  companion object {
    /** The folder under filesDir and cacheDir. */
    const val ROOT = "PulseKit"

    /** The shared folder's name under the library root. */
    const val SHARED = ".shared"

    /** The PR1-era namespace suffix: `<hostId>-local`, used before accounts existed. */
    const val LOCAL_SUFFIX = PulseNamespace.LOCAL_SUFFIX

    /** A namespace folder's name, never `.shared` or any other dot-name, and never a path. */
    fun isNamespaceName(name: String): Boolean =
      PulseValidation.isPlainName(name) && !name.startsWith(".")

    /** Create [dir] and its parents unless it is a folder already. */
    @Throws(IOException::class)
    fun makeDirs(dir: File) {
      if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) {
        throw IOException("couldn't create $dir")
      }
    }

    /**
     * Write [bytes] atomically: a temp file next to [file] (the facade's own `.native.part`, never
     * Pulse JS's `.part`), flushed to disk, then renamed over the old one.
     */
    @Throws(IOException::class)
    fun writeAtomically(bytes: ByteArray, file: File) {
      val dir = file.parentFile ?: throw IOException("$file has no folder")
      makeDirs(dir)
      val part = File(dir, "${file.name}.native.part")
      try {
        FileOutputStream(part).use { out ->
          out.write(bytes)
          out.flush()
          out.fd.sync()
        }
        if (!part.renameTo(file)) throw IOException("couldn't move $part into place")
      } finally {
        if (part.exists()) part.delete()
      }
    }

    /** The file's text (UTF-8), or null when it is missing or unreadable. */
    fun readText(file: File): String? =
      try {
        if (file.isFile) file.readText(Charsets.UTF_8) else null
      } catch (e: IOException) {
        null
      }

    /** catalog.json under [documents] (PulseCatalogReader's read order), or null. */
    fun readCatalog(documents: File): PulseCatalogReader.Catalog? =
      PulseCatalogReader.read { name -> readText(File(documents, name)) }

    /**
     * Bytes on disk under [root]: each regular file's allocated blocks (`st_blocks * 512`, its
     * length when the file system reports none), 0 when missing. Symbolic links aren't followed.
     */
    fun size(root: File): Long {
      var total = 0L
      val pending = ArrayDeque<File>()
      pending.addLast(root)
      while (pending.isNotEmpty()) {
        val f = pending.removeLast()
        val st = try {
          Os.lstat(f.path)
        } catch (e: ErrnoException) {
          continue
        }
        when {
          OsConstants.S_ISDIR(st.st_mode) -> f.listFiles()?.forEach { pending.addLast(it) }
          OsConstants.S_ISREG(st.st_mode) ->
            total += if (st.st_blocks > 0) st.st_blocks * 512 else st.st_size
        }
      }
      return total
    }

    /**
     * Drafts with a folder under `drafts/`: what a namespace without a catalog (PR1's `-local`)
     * still holds. Pulse keeps each draft's clips and covers in `drafts/<draftId>/`.
     */
    fun draftFolders(documents: File): Int =
      File(documents, "drafts").list()?.count { !it.startsWith(".") } ?: 0

    /**
     * Whether a namespace holds nothing a person made: no draft folders, no catalog rows, and no
     * result waiting in the inbox. An empty library database alone doesn't count.
     */
    fun isEmpty(documents: File): Boolean {
      if (draftFolders(documents) > 0) return false
      val catalog = readCatalog(documents)
      if (catalog != null && (catalog.drafts.isNotEmpty() || catalog.receipts.isNotEmpty())) {
        return false
      }
      val pending = File(documents, PulseInboxRules.FOLDER).list() ?: return true
      return pending.none { it.endsWith(".json") }
    }

    /** When the folder was last written, in ms since 1970 (0 when unknown). */
    fun modifiedAt(file: File): Long = file.lastModified()
  }
}
