// Mirrors embed/native/ios/PulseKitCatalog.swift: the facade's catalog reader (native-bridge.md
// §6.1). listDrafts, getDraft, countDrafts and the row counts behind usage, answered from
// catalog.json without starting Pulse's runtime.
//
// The rules are src/features/drafts/catalog-filter.ts, rule for rule. Kotlin, Swift and jest run
// the same vectors (src/features/drafts/__vectors__/catalog.json), so the three can't drift.
//
// Rows pass through whole: a field this reader doesn't know reaches the host unchanged. Text
// compares by UTF-16 code unit, as JavaScript's `===`, `<` and `startsWith` do; Kotlin's String
// equality and `compareTo` already do (Swift needed `.utf16` for that).

package com.mieweb.pulse.kit.core

/** What the reader knows about the network, and the host's Wi-Fi-only choice (`NetworkView`). */
data class PulseNetworkView(val online: Boolean, val wifi: Boolean, val wifiOnlyUploads: Boolean)

/** A catalog row (a DraftSummary as Pulse JS wrote it). */
typealias PulseCatalogRow = Map<String, PulseJson>

/** The catalog reader. */
object PulseCatalogReader {
  /** The catalog's name under the namespace's documents root, and where each write goes first. */
  const val FILE = "catalog.json"
  const val PART = "catalog.json.part"

  /** Every state but 'sent': listDrafts' and countDrafts' default. */
  @JvmField
  val unsent: List<String> = listOf(
    "draft", "ready", "preparing", "queued", "waiting_network", "uploading", "delivering",
    "needs_credentials", "failed",
  )

  /** Shown states that count as uploading in `usage` (the fake's rule, PR2-K). */
  @JvmField
  val uploadingStates: Set<String> =
    setOf("preparing", "queued", "waiting_network", "uploading", "delivering")

  /** A parsed `catalog.json`. Unknown top-level fields are kept in [raw]. */
  data class Catalog(
    val raw: Map<String, PulseJson>,
    val drafts: List<PulseCatalogRow>,
    val receipts: List<PulseCatalogRow>,
  ) {
    /**
     * Written by a newer schema. The facade passes it on and refuses nothing for it: such a
     * library still lists, sends and deletes (PLAN-final AD34); Pulse JS refuses only edits.
     */
    val readOnly: Boolean get() = raw["readOnly"]?.bool ?: false

    /** When Pulse JS wrote it, in milliseconds. */
    val writtenAt: Double? get() = number(raw["writtenAt"])

    /** The catalog with every FileRef's `path` rebuilt from its `rel` under [documents]. */
    fun rebased(documents: String): Catalog =
      Catalog(raw, drafts.map { rebase(it, documents) }, receipts.map { rebase(it, documents) })

    /** The empty catalog (no file yet). */
    companion object {
      @JvmField
      val EMPTY = Catalog(emptyMap(), emptyList(), emptyList())
    }
  }

  // File paths

  /**
   * [row] with every FileRef in it (`poster`, `export`, or any other top-level `{rel, path}`
   * object) pointing under [documents], the namespace's documents root now. The writer stores
   * `path` as `<root>/<rel>` with the root it had then; `rel` is what stays true. A FileRef whose
   * `rel` isn't a plain relative path (absolute, empty, or with a `.` or `..` part) is left as it
   * is. On Android the root rarely moves (no container UUID), but a restore to another user or
   * profile can, so the rule is kept.
   */
  @JvmStatic
  fun rebase(row: PulseCatalogRow, documents: String): PulseCatalogRow {
    val base = if (documents.endsWith("/")) documents.dropLast(1) else documents
    val out = LinkedHashMap(row)
    for ((key, value) in row) {
      val ref = value.obj ?: continue
      val rel = ref["rel"]?.string ?: continue
      if (ref["path"]?.string == null || !isPlainRelative(rel)) continue
      val moved = LinkedHashMap(ref)
      moved["path"] = PulseJson.Str("$base/$rel")
      out[key] = PulseJson.Obj(moved)
    }
    return out
  }

  internal fun isPlainRelative(rel: String): Boolean {
    if (rel.isEmpty() || rel.startsWith("/")) return false
    return rel.split("/").none { it.isEmpty() || it == "." || it == ".." }
  }

  // Reading

  /** [text] as a catalog, or null when it isn't one (missing, cut short, or another file). */
  @JvmStatic
  fun parse(text: String?): Catalog? {
    val top = text?.let { PulseJson.parse(it) }?.obj ?: return null
    if (top["format"]?.string != "pulse-catalog") return null
    if (number(top["version"]) == null) return null
    val drafts = top["drafts"]?.array ?: return null
    val receipts = top["receipts"]?.array ?: return null
    return Catalog(top, drafts.mapNotNull { it.obj }, receipts.mapNotNull { it.obj })
  }

  /**
   * How a reader finds the catalog (catalog-filter.ts `readCatalogFile`). [read] returns the
   * file's text, or null when there's no such file. In order: `catalog.json`; when it's missing,
   * `catalog.json.part` (the writer's move deletes the old file before moving the `.part` in); and
   * when that is missing or cut short, `catalog.json` once more (the move landed in between).
   * Nothing that parses means no catalog: the reader answers as if it were empty.
   */
  @JvmStatic
  fun read(read: (String) -> String?): Catalog? =
    parse(read(FILE)) ?: parse(read(PART)) ?: parse(read(FILE))

  // Arguments

  /** Why a call's arguments were refused; the message goes into `invalid_options`. */
  data class ArgsProblem(val message: String)

  /** A parse that either gives a value or an [ArgsProblem]. */
  sealed class Parsed<out T> {
    /** Accepted. */
    data class Ok<T>(val value: T) : Parsed<T>()

    /** Refused. */
    data class Problem(val problem: ArgsProblem) : Parsed<Nothing>()
  }

  /** `DraftFilter`. */
  data class Filter(
    val contextKey: String? = null,
    val contextKeyPrefix: String? = null,
    val contextKind: String? = null,
    /** Default: every state but 'sent'. */
    val states: List<String>? = null,
  ) {
    /** Reading a filter from a call's args. */
    companion object {
      /** A null field is the same as a missing one; unknown fields are ignored. */
      @JvmStatic
      fun from(args: Map<String, PulseJson>): Parsed<Filter> = try {
        Parsed.Ok(
          Filter(
            optionalString(args, "contextKey"),
            optionalString(args, "contextKeyPrefix"),
            optionalString(args, "contextKind"),
            optionalStates(args),
          ),
        )
      } catch (e: ProblemException) {
        Parsed.Problem(e.problem)
      }
    }
  }

  /** `CountOptions`. */
  data class CountOptions(
    val by: By,
    /** Only rows that need the person: 'failed', and 'sent' kept by the server, not dismissed. */
    val attentionOnly: Boolean = false,
    val states: List<String>? = null,
  ) {
    /** What to group by. */
    enum class By(val wire: String) {
      /** Each place. */
      CONTEXT_KEY("contextKey"),

      /** Each kind of place. */
      CONTEXT_KIND("contextKind"),
    }

    /** Reading options from a call's args. */
    companion object {
      /** `by` is required; `attentionOnly` must be a boolean; `states` strings. */
      @JvmStatic
      fun from(args: Map<String, PulseJson>): Parsed<CountOptions> {
        val raw = args["by"]?.string
        val by = By.values().firstOrNull { it.wire == raw }
          ?: return Parsed.Problem(ArgsProblem("by must be 'contextKey' or 'contextKind'."))
        val attentionOnly = when (val a = args["attentionOnly"]) {
          null, PulseJson.Null -> false
          is PulseJson.Bool -> a.value
          else -> return Parsed.Problem(ArgsProblem("attentionOnly must be a boolean."))
        }
        return try {
          Parsed.Ok(CountOptions(by, attentionOnly, optionalStates(args)))
        } catch (e: ProblemException) {
          Parsed.Problem(e.problem)
        }
      }
    }
  }

  /** Carries an [ArgsProblem] out of the field readers. */
  private class ProblemException(val problem: ArgsProblem) : Exception(problem.message)

  private fun optionalString(args: Map<String, PulseJson>, key: String): String? =
    when (val v = args[key]) {
      null, PulseJson.Null -> null
      is PulseJson.Str -> v.value
      else -> throw ProblemException(ArgsProblem("$key must be a string."))
    }

  private fun optionalStates(args: Map<String, PulseJson>): List<String>? =
    when (val v = args["states"]) {
      null, PulseJson.Null -> null
      is PulseJson.Arr -> v.items.map {
        it.string ?: throw ProblemException(ArgsProblem("states must be strings."))
      }
      else -> throw ProblemException(ArgsProblem("states must be an array."))
    }

  // Rules (catalog-filter.ts)

  /**
   * The state the host sees: a queued upload waits for the network while there is none, or while
   * uploads wait for Wi-Fi and there's no Wi-Fi. The catalog never stores `waiting_network`.
   */
  @JvmStatic
  fun shownState(state: String?, net: PulseNetworkView): String? {
    if (state != "queued") return state
    return if (!net.online || (net.wifiOnlyUploads && !net.wifi)) "waiting_network" else "queued"
  }

  /**
   * The catalog's order: the newest change first, equal times by id (ascending, by UTF-16 code
   * unit). True when [a] comes before [b].
   */
  @JvmStatic
  fun before(a: PulseCatalogRow, b: PulseCatalogRow): Boolean {
    // `b.updatedAt - a.updatedAt || idOrder`: a missing time is NaN, and NaN falls to the id.
    val d = (number(b["updatedAt"]) ?: Double.NaN) - (number(a["updatedAt"]) ?: Double.NaN)
    if (d != 0.0 && !d.isNaN()) return d < 0
    val x = a["id"]?.string ?: return false
    val y = b["id"]?.string ?: return false
    return x < y
  }

  /**
   * The catalog's rows in the states asked for, with their shown state, in catalog order.
   * JavaScript's sort is stable, so rows the order can't tell apart keep their file order. The
   * sort is a merge sort on [before] alone, which never throws on an inconsistent order (rows with
   * odd fields) the way a Comparator-based sort may.
   */
  internal fun rows(
    catalog: Catalog,
    states: List<String>,
    net: PulseNetworkView,
  ): List<PulseCatalogRow> {
    val wanted = states.toSet()
    val all = if ("sent" in wanted) catalog.drafts + catalog.receipts else catalog.drafts
    val shown = all.mapNotNull { row ->
      val state = shownState(row["state"]?.string, net)
      if (state == null || state !in wanted) null else withState(row, state)
    }
    return stableSort(shown)
  }

  private fun withState(row: PulseCatalogRow, state: String?): PulseCatalogRow {
    val r = LinkedHashMap(row)
    if (state == null) r.remove("state") else r["state"] = PulseJson.Str(state)
    return r
  }

  private fun stableSort(rows: List<PulseCatalogRow>): List<PulseCatalogRow> {
    if (rows.size < 2) return rows
    val mid = rows.size / 2
    val left = stableSort(rows.subList(0, mid))
    val right = stableSort(rows.subList(mid, rows.size))
    val out = ArrayList<PulseCatalogRow>(rows.size)
    var i = 0
    var j = 0
    while (i < left.size && j < right.size) {
      // Take from the right only when it strictly comes first: ties keep their order.
      if (before(right[j], left[i])) out.add(right[j++]) else out.add(left[i++])
    }
    while (i < left.size) out.add(left[i++])
    while (j < right.size) out.add(right[j++])
    return out
  }

  private fun context(row: PulseCatalogRow): Map<String, PulseJson>? = row["context"]?.obj

  /** `listDrafts(filter)`: rows in the asked states for the asked place, newest change first. */
  @JvmStatic
  fun listDrafts(catalog: Catalog, filter: Filter, net: PulseNetworkView): List<PulseCatalogRow> =
    rows(catalog, filter.states ?: unsent, net).filter { row ->
      val key = context(row)?.get("key")?.string
      if (filter.contextKey != null && key != filter.contextKey) return@filter false
      val prefix = filter.contextKeyPrefix
      if (prefix != null && (key == null || !key.startsWith(prefix))) return@filter false
      if (filter.contextKind != null && context(row)?.get("kind")?.string != filter.contextKind) {
        return@filter false
      }
      true
    }

  /** `getDraft(id)`: the row with that id, a draft or a receipt, with its shown state. */
  @JvmStatic
  fun getDraft(catalog: Catalog, id: String, net: PulseNetworkView): PulseCatalogRow? {
    val row = (catalog.drafts + catalog.receipts).firstOrNull { it["id"]?.string == id }
      ?: return null
    return withState(row, shownState(row["state"]?.string, net))
  }

  /**
   * Whether a row needs the person: its upload failed, or the server kept it and they haven't
   * seen it.
   */
  @JvmStatic
  fun needsAttention(row: PulseCatalogRow): Boolean {
    val state = row["state"]?.string
    if (state == "failed") return true
    if (state != "sent") return false
    val sent = row["sent"]?.obj ?: return false
    return sent["outcome"]?.string == "kept" && !truthy(sent["dismissed"])
  }

  /**
   * `countDrafts(options)`: how many rows each place (`CONTEXT_KEY`) or kind of place
   * (`CONTEXT_KIND`) has, in the asked states (default every state but 'sent'), or with
   * `attentionOnly` only those that need the person. Rows without a place aren't counted; places
   * with none are left out. Groups are told apart by UTF-16 code unit, in first-seen order.
   */
  @JvmStatic
  fun countDrafts(
    catalog: Catalog,
    options: CountOptions,
    net: PulseNetworkView,
  ): List<Pair<String, Int>> {
    val states = options.states ?: (if (options.attentionOnly) unsent + "sent" else unsent)
    val counts = LinkedHashMap<String, Int>()
    for (row in rows(catalog, states, net)) {
      val ctx = context(row) ?: continue
      if (options.attentionOnly && !needsAttention(row)) continue
      val field = if (options.by == CountOptions.By.CONTEXT_KIND) "kind" else "key"
      val group = ctx[field]?.string ?: continue
      counts[group] = (counts[group] ?: 0) + 1
    }
    return counts.map { it.key to it.value }
  }

  /** The row counts `usage` reports (the bytes come from the folders). */
  data class Counts(
    val drafts: Int = 0,
    /** Every state but 'sent'. The kill switch keeps Pulse reachable while > 0 (AD25). */
    val unsent: Int = 0,
    val uploading: Int = 0,
    val failed: Int = 0,
    val receipts: Int = 0,
  )

  /** `usage`'s row counts; a `waiting_network` row (derived from [net]) counts as uploading. */
  @JvmStatic
  fun counts(catalog: Catalog, net: PulseNetworkView): Counts {
    var uploading = 0
    var failed = 0
    for (row in catalog.drafts) {
      val state = shownState(row["state"]?.string, net) ?: ""
      if (state in uploadingStates) uploading++
      if (state == "failed") failed++
    }
    return Counts(
      drafts = catalog.drafts.size,
      unsent = catalog.drafts.size,
      uploading = uploading,
      failed = failed,
      receipts = catalog.receipts.size,
    )
  }

  // JavaScript's view of JSON values

  /** A JSON number (never a boolean). */
  internal fun number(v: PulseJson?): Double? = when (v) {
    is PulseJson.Integer -> v.value.toDouble()
    is PulseJson.Num -> v.value
    else -> null
  }

  /** JavaScript truthiness of a JSON value. */
  internal fun truthy(v: PulseJson?): Boolean = when (v) {
    null, PulseJson.Null -> false
    is PulseJson.Bool -> v.value
    is PulseJson.Integer -> v.value != 0L
    is PulseJson.Num -> v.value != 0.0 && !v.value.isNaN()
    is PulseJson.Str -> v.value.isNotEmpty()
    is PulseJson.Arr, is PulseJson.Obj -> true
  }
}
