// Runs the shared vectors against PulseKit's Android core (embed/native/android/src/main/java/
// com/mieweb/pulse/kit/core), on a JVM, with no Android build:
//
//   gradle --offline -q -p embed/native/android/jvm-tests run --args="$PWD"
//
// The argument is the repository root. Three files, each checked the way its other runners check
// it, so the counts line up:
// - embed/native/ios/vectors/envelope.json: tests/EnvelopeVectorsMain.swift's checks (65).
// - src/features/drafts/__vectors__/catalog.json: tests/CatalogVectorsMain.swift's checks,
//   `facade:` ones included (58).
// - embed/native/ios/namespace-vectors.json: embed/src/accounts/namespace-vectors.test.ts's checks
//   (31; Swift has no runner for this file, its cases are device cases).
// Then `kotlin:` checks for what only this core has (forwarded routing, the full method list, the
// JSON writer, the 8 KB context rule, setAccount's arguments and account.json).
//
// Prints one line per check (`ok` or `FAIL <section>: <name>: <detail>`), the counts per file and
// section, and exits 1 when any check fails or a file ran none.

package com.mieweb.pulse.kit.vectors

import com.mieweb.pulse.kit.core.OpenDecision
import com.mieweb.pulse.kit.core.PresenterState
import com.mieweb.pulse.kit.core.PulseAccountArgs
import com.mieweb.pulse.kit.core.PulseAccountChoice
import com.mieweb.pulse.kit.core.PulseAccountFile
import com.mieweb.pulse.kit.core.PulseBusy
import com.mieweb.pulse.kit.core.PulseCatalogReader
import com.mieweb.pulse.kit.core.PulseCatalogReader.Catalog
import com.mieweb.pulse.kit.core.PulseCatalogReader.CountOptions
import com.mieweb.pulse.kit.core.PulseCatalogReader.Filter
import com.mieweb.pulse.kit.core.PulseCatalogReader.Parsed
import com.mieweb.pulse.kit.core.PulseCatalogRow
import com.mieweb.pulse.kit.core.PulseChecked
import com.mieweb.pulse.kit.core.PulseContract
import com.mieweb.pulse.kit.core.PulseError
import com.mieweb.pulse.kit.core.PulseEvent
import com.mieweb.pulse.kit.core.PulseInboxEntry
import com.mieweb.pulse.kit.core.PulseInboxRules
import com.mieweb.pulse.kit.core.PulseJson
import com.mieweb.pulse.kit.core.PulseNamespace
import com.mieweb.pulse.kit.core.PulseNetworkView
import com.mieweb.pulse.kit.core.PulseOrigin
import com.mieweb.pulse.kit.core.PulseReply
import com.mieweb.pulse.kit.core.PulseRoute
import com.mieweb.pulse.kit.core.PulseRouter
import com.mieweb.pulse.kit.core.PulseValidation
import java.io.File
import java.text.Normalizer
import kotlin.system.exitProcess

/** The vectors runner: `main(arrayOf(repoRoot))`. */
object VectorsMain {
  /** Counts for one file, by section, in the order sections first ran. */
  private class Tally(val file: String) {
    val passed = LinkedHashMap<String, Int>()
    val failed = LinkedHashMap<String, Int>()
    val total: Int get() = passed.values.sum() + failed.values.sum()
    val failures: Int get() = failed.values.sum()
  }

  private val tallies = ArrayList<Tally>()
  private lateinit var tally: Tally

  private fun check(ok: Boolean, section: String, name: String, detail: () -> String = { "" }) {
    if (ok) {
      tally.passed[section] = (tally.passed[section] ?: 0) + 1
      tally.failed.putIfAbsent(section, 0)
      println("ok      $section: $name")
    } else {
      tally.failed[section] = (tally.failed[section] ?: 0) + 1
      tally.passed.putIfAbsent(section, 0)
      println("FAIL    $section: $name: ${detail()}")
    }
  }

  /** Entry point; `args[0]` is the repository root. */
  @JvmStatic
  fun main(args: Array<String>) {
    if (args.size != 1) {
      println("usage: VectorsMain <repository root>")
      exitProcess(2)
    }
    val root = File(args[0])
    val envelope = load(root, "embed/native/ios/vectors/envelope.json")
    val catalog = load(root, "src/features/drafts/__vectors__/catalog.json")
    val namespace = load(root, "embed/native/ios/namespace-vectors.json")

    begin("envelope.json")
    runEnvelope(envelope)
    begin("catalog.json")
    runCatalog(catalog)
    begin("namespace-vectors.json")
    runNamespace(namespace)
    begin("kotlin core")
    runKotlin(namespace)

    println()
    var failed = 0
    var empty = false
    for (t in tallies) {
      val sections = t.passed.keys.joinToString(", ") { s ->
        val f = t.failed[s] ?: 0
        "$s ${t.passed[s]}" + if (f > 0) " (+$f failed)" else ""
      }
      println("${t.file}: ${t.total - t.failures} passed, ${t.failures} failed [$sections]")
      failed += t.failures
      if (t.total == 0) empty = true
    }
    val all = tallies.sumOf { it.total }
    println("\n${all - failed} passed, $failed failed")
    exitProcess(if (failed == 0 && !empty) 0 else 1)
  }

  private fun begin(file: String) {
    tally = Tally(file)
    tallies.add(tally)
  }

  private fun load(root: File, rel: String): PulseJson {
    val f = File(root, rel)
    val text = try {
      f.readText(Charsets.UTF_8)
    } catch (e: Exception) {
      println("can't read $f: ${e.message}")
      exitProcess(2)
    }
    return PulseJson.parse(text) ?: run {
      println("$f isn't JSON")
      exitProcess(2)
    }
  }

  private fun list(v: PulseJson?): List<PulseJson> = v?.array ?: emptyList()

  private fun strings(v: PulseJson?): List<String> = list(v).mapNotNull { it.string }

  // envelope.json (tests/EnvelopeVectorsMain.swift)

  private fun runEnvelope(vectors: PulseJson) {
    check(
      vectors["contract"]?.get("major")?.integer == PulseContract.MAJOR.toLong() &&
        vectors["contract"]?.get("minor")?.integer == PulseContract.VECTORS_MINOR.toLong(),
      "contract", "the vectors' major/minor match the facade",
    )
    check(
      strings(vectors["methods"]?.get("native")) == PulseContract.nativeMethods,
      "contract", "native method list",
    ) { "${PulseContract.nativeMethods}" }
    check(
      strings(vectors["methods"]?.get("minor1")) == PulseContract.minor1Methods,
      "contract", "minor-1 method list",
    ) { "${PulseContract.minor1Methods}" }
    list(vectors["requests"]).forEach(::checkRequest)
    list(vectors["replies"]).forEach(::checkReply)
    list(vectors["open"]).forEach(::checkOpen)
    list(vectors["busy"]).forEach(::checkBusy)
    list(vectors["inbox"]).forEach(::checkInbox)
    list(vectors["acknowledge"]).forEach(::checkAcknowledge)
    list(vectors["namespace"]).forEach(::checkNamespace)
    list(vectors["configure"]).forEach(::checkConfigure)
  }

  private fun checkRequest(v: PulseJson) {
    val name = v["name"]?.string ?: "?"
    val text = v["requestText"]?.string ?: v["request"]?.serialized ?: ""
    val supported = v["supported"]?.bool ?: true
    val expect = v["expect"] ?: PulseJson.Null
    val route = PulseRouter.route(text, supported = supported)
    when {
      route is PulseRoute.Native && expect["route"]?.string == "native" -> check(
        route.method == expect["method"]?.string && PulseJson.Obj(route.args) == expect["args"],
        "request", name,
      ) { "got ${route.method} ${PulseJson.Obj(route.args).serialized}" }
      route is PulseRoute.Reply && expect["route"]?.string == "reply" -> {
        val reply = route.reply
        val replyJson = PulseJson.parse(reply.serialized)
        val ok = !reply.ok && reply.v == 1 &&
          reply.callId == expect["callId"]?.string &&
          reply.error?.callId == expect["callId"]?.string &&
          reply.error?.code == expect["error"]?.get("code")?.string &&
          reply.error?.recoverable == expect["error"]?.get("recoverable")?.bool &&
          !(reply.error?.message.isNullOrEmpty()) &&
          replyJson?.get("result") == null
        check(ok, "request", name) { reply.serialized }
      }
      else -> check(false, "request", name) { "routed $route" }
    }
  }

  private fun checkReply(v: PulseJson) {
    val name = v["name"]?.string ?: "?"
    val build = v["build"]
    val parse = v["parse"]?.string
    if (build != null) {
      val callId = build["callId"]?.string ?: ""
      val reply = if (build["ok"]?.bool == true) {
        PulseReply.success(callId, build["result"] ?: PulseJson.Null)
      } else {
        val e = build["error"] ?: PulseJson.Null
        PulseReply.failure(
          e["code"]?.string ?: "", e["message"]?.string ?: "", callId, e["requestId"]?.string,
        )
      }
      check(reply.serialized == v["expectText"]?.string, "reply", name) { reply.serialized }
    } else if (parse != null) {
      val decoded = PulseReply.parse(parse)
      val expect = v["expect"] ?: PulseJson.Null
      check(
        decoded != null && decoded.ok == expect["ok"]?.bool &&
          decoded.callId == expect["callId"]?.string && decoded.result == expect["result"],
        "reply", name,
      ) { decoded?.serialized ?: "didn't decode" }
    }
  }

  private fun checkOpen(v: PulseJson) {
    val name = v["name"]?.string ?: "?"
    val expect = v["expect"] ?: PulseJson.Null
    when (val r = PulseValidation.open(v["args"]?.obj ?: emptyMap(), "c-open")) {
      is PulseChecked.Ok -> check(
        expect["ok"]?.bool == true && r.value.entry == expect["entry"]?.string &&
          r.value.requestId == expect["requestId"]?.string,
        "open", name,
      ) { "accepted ${r.value.entry} ${r.value.requestId}" }
      is PulseChecked.Invalid -> check(
        expect["ok"]?.bool == false && r.error.code == expect["code"]?.string &&
          r.error.callId == "c-open",
        "open", name,
      ) { "refused ${r.error.code}: ${r.error.message}" }
    }
  }

  private fun checkBusy(v: PulseJson) {
    val name = v["name"]?.string ?: "?"
    val presenter = PresenterState.fromWire(v["presenter"]?.string)
      ?: return check(false, "busy", name) { "bad presenter" }
    val decision = PulseBusy.decideOpen(
      v["open"]?.string, v["requestId"]?.string, presenter, v["pending"]?.bool ?: false,
    )
    check(decision.wire == v["expect"]?.string, "busy", name) { decision.wire }
  }

  private fun checkInbox(v: PulseJson) {
    val name = v["name"]?.string ?: "?"
    val entries = list(v["files"]).map {
      PulseInboxEntry(it["name"]?.string ?: "", (it["modified"]?.integer ?: 0).toDouble())
    }
    val got = PulseInboxRules.pending(entries)
    check(got == strings(v["expect"]), "inbox", name) { "$got" }
  }

  private fun checkAcknowledge(v: PulseJson) {
    val id = v["requestId"]?.string ?: ""
    val got = PulseInboxRules.acknowledgeFiles(id)
    check(got == strings(v["expect"]), "acknowledge", "deletes $id's files") { "$got" }
  }

  private fun checkNamespace(v: PulseJson) {
    val bundleId = v["bundleId"]?.string ?: ""
    val got = PulseNamespace.local(PulseNamespace.sanitise(bundleId))
    check(
      got == v["expect"]?.string && PulseValidation.isPlainName(got), "namespace", bundleId,
    ) { got }
  }

  private fun checkConfigure(v: PulseJson) {
    val args = v["args"]?.obj ?: emptyMap()
    val got = PulseValidation.configure(args, "c-configure")?.code ?: "ok"
    check(got == v["expect"]?.string, "configure", PulseJson.Obj(args).serialized) { got }
  }

  // catalog.json (tests/CatalogVectorsMain.swift)

  private val on = PulseNetworkView(online = true, wifi = true, wifiOnlyUploads = false)
  private val off = PulseNetworkView(online = false, wifi = false, wifiOnlyUploads = false)

  private fun net(v: PulseJson?) = PulseNetworkView(
    online = v?.get("online")?.bool ?: true,
    wifi = v?.get("wifi")?.bool ?: true,
    wifiOnlyUploads = v?.get("wifiOnlyUploads")?.bool ?: false,
  )

  private fun pairs(rows: List<PulseCatalogRow>): List<List<String>> =
    rows.map { listOf(it["id"]?.string ?: "?", it["state"]?.string ?: "?") }

  private fun runCatalog(vectors: PulseJson) {
    check(
      vectors["format"]?.string == "pulse-catalog-vectors" && vectors["version"]?.integer == 1L,
      "format", "the vectors file this reader knows",
    )
    // Through the writer and back, as Swift goes through JSONSerialization.
    val catalog = vectors["catalog"]?.let { PulseCatalogReader.parse(it.serialized) }
    if (catalog == null) {
      check(false, "catalog", "the vectors' catalog parses")
      return
    }
    check(
      catalog.drafts.all { it["state"]?.string != "waiting_network" },
      "catalog", "no stored waiting_network",
    )
    list(vectors["listDrafts"]).forEach { checkList(it, catalog) }
    list(vectors["countDrafts"]).forEach { checkCount(it, catalog) }
    list(vectors["shownState"]).forEach(::checkShown)
    list(vectors["readCatalog"]).forEach(::checkRead)
    checkFacade(catalog)
  }

  private fun checkList(v: PulseJson, catalog: Catalog) {
    val name = v["name"]?.string ?: "?"
    val parsed = Filter.from(v["filter"]?.obj ?: emptyMap())
    if (parsed !is Parsed.Ok) return check(false, "listDrafts", name) { "the filter didn't parse" }
    val expect = list(v["expect"]).map { strings(it) }
    val got = pairs(PulseCatalogReader.listDrafts(catalog, parsed.value, net(v["net"])))
    check(got == expect, "listDrafts", name) { "got $got" }
  }

  private fun checkCount(v: PulseJson, catalog: Catalog) {
    val name = v["name"]?.string ?: "?"
    val parsed = CountOptions.from(v["options"]?.obj ?: emptyMap())
    if (parsed !is Parsed.Ok) {
      return check(false, "countDrafts", name) { "the options didn't parse" }
    }
    val expect = (v["expect"]?.obj ?: emptyMap()).mapValues { it.value.integer?.toInt() }
    val got = PulseCatalogReader.countDrafts(catalog, parsed.value, net(v["net"])).toMap()
    check(got == expect, "countDrafts", name) { "got $got" }
  }

  private fun checkShown(v: PulseJson) {
    val name = v["name"]?.string ?: "?"
    val got = PulseCatalogReader.shownState(v["state"]?.string, net(v["net"]))
    check(got == v["expect"]?.string, "shownState", name) { "got $got" }
  }

  private fun checkRead(v: PulseJson) {
    val name = v["name"]?.string ?: "?"
    val reads = v["reads"]?.obj ?: emptyMap()
    val seen = HashMap<String, Int>()
    val found = PulseCatalogReader.read { file ->
      val answers = reads[file]?.array ?: listOf(PulseJson.Null)
      val i = minOf(seen[file] ?: 0, answers.size - 1)
      seen[file] = i + 1
      answers[i].string
    }
    val expect = when (val e = v["expect"]) {
      is PulseJson.Integer -> e.value.toDouble()
      is PulseJson.Num -> e.value
      else -> null
    }
    check(found?.writtenAt == expect, "readCatalog", name) { "got ${found?.writtenAt}" }
  }

  private fun refuses(p: Parsed<*>) = p is Parsed.Problem

  private fun row(id: String, key: String, at: Long): PulseCatalogRow = linkedMapOf(
    "id" to PulseJson.Str(id),
    "state" to PulseJson.Str("draft"),
    "updatedAt" to PulseJson.Integer(at),
    "context" to PulseJson.obj("key" to PulseJson.Str(key), "kind" to PulseJson.Str("ticket")),
  )

  private fun checkFacade(catalog: Catalog) {
    val f = "facade"
    val r = PulseCatalogReader
    val queued = r.getDraft(catalog, "d-queued", off)
    check(
      queued?.get("state")?.string == "waiting_network" &&
        queued["upload"]?.get("clientKey")?.string == "inst-1:d-queued:0123456789abcdef",
      f, "getDraft shows a queued draft offline as waiting_network, its fields passed through",
    )
    check(
      r.getDraft(catalog, "r-kept", on)?.get("state")?.string == "sent",
      f, "getDraft finds a receipt",
    )
    check(r.getDraft(catalog, "nope", on) == null, f, "getDraft of an unknown id is nil")

    val expected =
      PulseCatalogReader.Counts(drafts = 7, unsent = 7, uploading = 2, failed = 1, receipts = 3)
    check(r.counts(catalog, on) == expected, f, "usage counts online") {
      "${r.counts(catalog, on)}"
    }
    check(
      r.counts(catalog, off) == expected,
      f, "usage counts offline (waiting_network still counts as uploading)",
    ) { "${r.counts(catalog, off)}" }
    check(
      r.counts(Catalog.EMPTY, on) == PulseCatalogReader.Counts(), f, "no catalog counts nothing",
    )

    check(r.parse(null) == null, f, "no file is no catalog")
    check(r.parse("[1,2]") == null, f, "a JSON array is no catalog")
    check(
      r.parse("""{"format":"pulse-catalog","version":true,"drafts":[],"receipts":[]}""") == null,
      f, "a boolean version is no catalog",
    )
    check(
      r.parse(
        """{"format":"pulse-catalog","version":1,"readOnly":true,"drafts":[],"receipts":[]}""",
      )?.readOnly == true,
      f, "readOnly passes through",
    )

    check(
      refuses(Filter.from(mapOf("contextKey" to PulseJson.Integer(5)))),
      f, "a non-string contextKey is invalid",
    )
    check(
      refuses(
        Filter.from(
          mapOf("states" to PulseJson.Arr(listOf(PulseJson.Str("queued"), PulseJson.Integer(1)))),
        ),
      ),
      f, "a non-string state is invalid",
    )
    val nullField =
      Filter.from(mapOf("contextKey" to PulseJson.Null, "extra" to PulseJson.Integer(1)))
    check(
      nullField is Parsed.Ok && nullField.value.contextKey == null,
      f, "a null field is a missing one; unknown fields are ignored",
    )
    check(
      refuses(
        CountOptions.from(
          mapOf("by" to PulseJson.Str("contextKey"), "attentionOnly" to PulseJson.Integer(1)),
        ),
      ),
      f, "attentionOnly must be a boolean",
    )
    check(
      refuses(CountOptions.from(mapOf("by" to PulseJson.Str("place")))),
      f, "by must be contextKey or contextKind",
    )

    // JavaScript compares UTF-16 code units: a decomposed "é" is not a precomposed one.
    val composed = "ticket:caf\u00E9"
    val decomposed = "ticket:cafe\u0301"
    val unicode =
      Catalog(emptyMap(), listOf(row("a", composed, 2), row("b", decomposed, 1)), emptyList())
    check(
      pairs(r.listDrafts(unicode, Filter(contextKey = composed), on)) ==
        listOf(listOf("a", "draft")),
      f, "contextKey compares UTF-16 code units",
    )
    check(
      pairs(r.listDrafts(unicode, Filter(contextKeyPrefix = "ticket:cafe"), on)) ==
        listOf(listOf("b", "draft")),
      f, "contextKeyPrefix compares UTF-16 code units",
    )
    check(
      r.countDrafts(unicode, CountOptions(CountOptions.By.CONTEXT_KEY), on).size == 2,
      f, "countDrafts keeps canonically equivalent keys apart",
    )
    // A catalog written under another root: paths are rebuilt from `rel` under today's root.
    val now = "/data/user/0/org.example.host/no_backup/PulseKit/ns"
    val moved = catalog.rebased("$now/")
    val ready = r.getDraft(moved, "d-ready", on)
    val poster = ready?.get("poster")
    val export = ready?.get("export")
    check(
      poster?.get("path")?.string == now + "/" + (poster?.get("rel")?.string ?: "?") &&
        export?.get("path")?.string == "$now/drafts/d-ready/export.mp4" &&
        export?.get("rel")?.string == "drafts/d-ready/export.mp4",
      f, "FileRef paths are rebuilt from rel under the current documents root",
    ) { "got $poster $export" }
    check(
      r.listDrafts(moved, Filter(states = r.unsent + "sent"), on).all { row ->
        listOf("poster", "export").all { key ->
          val ref = row[key]?.obj ?: return@all true
          ref["path"]?.string?.startsWith("$now/") == true
        }
      } && moved.drafts.size == catalog.drafts.size,
      f, "every listed FileRef points under the current root",
    )
    val odd: PulseCatalogRow = linkedMapOf(
      "id" to PulseJson.Str("x"),
      "poster" to PulseJson.obj(
        "rel" to PulseJson.Str("../escape.jpg"), "path" to PulseJson.Str("/old/escape.jpg"),
        "webUrl" to PulseJson.Str(""),
      ),
      "export" to PulseJson.obj(
        "rel" to PulseJson.Str("/abs.mp4"), "path" to PulseJson.Str("/old/abs.mp4"),
        "webUrl" to PulseJson.Str(""),
      ),
    )
    val oddOut = r.rebase(odd, now)
    check(
      oddOut["poster"]?.get("path")?.string == "/old/escape.jpg" &&
        oddOut["export"]?.get("path")?.string == "/old/abs.mp4",
      f, "a rel that isn't a plain relative path is left as it is",
    )
    val ties = Catalog(
      emptyMap(), listOf(row("b", "k", 5), row("B", "k", 5), row("a", "k", 5)), emptyList(),
    )
    check(
      pairs(r.listDrafts(ties, Filter(), on)).map { it[0] } == listOf("B", "a", "b"),
      f, "equal times sort by id code unit ('B' < 'a')",
    )
  }

  // namespace-vectors.json (embed/src/accounts/namespace-vectors.test.ts)

  private fun runNamespace(file: PulseJson) {
    val vectors = list(file["vectors"])
    check(
      file["format"]?.string == "pulsekit-namespace-vectors" && file["version"]?.integer == 1L &&
        vectors.size == 5,
      "format", "the vectors file this runner knows, with five vectors",
    )
    for (v in vectors) {
      val name = v["name"]?.string ?: "?"
      val hostId = v["hostId"]?.string ?: ""
      val origin = PulseOrigin.normalise(v["serverOrigin"]?.string ?: "")
      check(origin == v["origin"]?.string, "origin", name) { "got $origin" }
      val ns = PulseNamespace.account(hostId, v["origin"]?.string ?: "", v["userId"]?.string ?: "")
      check(ns == v["namespace"]?.string, "namespace", name) { "got $ns" }
      val expected = v["namespace"]?.string ?: ""
      check(
        PulseValidation.isPlainName(expected) &&
          Regex("^" + Regex.escape(hostId) + "-[0-9a-f]{16}$").matches(expected),
        "plain", name,
      ) { expected }
    }
    if (vectors.size >= 2) {
      val plain = vectors[0]
      val noisy = vectors[1]
      check(
        noisy["serverOrigin"] != plain["serverOrigin"] && noisy["namespace"] == plain["namespace"],
        "rule", "origins that differ only in case, default port and path give the same namespace",
      )
    }
    val distinct = vectors.drop(1).mapNotNull { it["namespace"]?.string }.toSet()
    check(
      distinct.size == vectors.size - 1,
      "rule", "different people, servers and hosts give different namespaces",
    )
    val decomposed = vectors.firstOrNull { it["userId"]?.string?.contains('\u0301') == true }
    check(
      decomposed != null &&
        PulseNamespace.account(
          decomposed["hostId"]?.string ?: "",
          decomposed["origin"]?.string ?: "",
          Normalizer.normalize(decomposed["userId"]?.string ?: "", Normalizer.Form.NFC),
        ) != decomposed["namespace"]?.string,
      "rule", "the userId is hashed as given: a decomposed é is not normalised",
    )
    for (origin in strings(file["invalidOrigins"])) {
      val got = PulseOrigin.normalise(origin)
      check(got == null, "invalid", "refuses the origin \"$origin\"") { "got $got" }
    }
  }

  // What only the Kotlin core has

  private fun runKotlin(namespaceFile: PulseJson) {
    val k = "kotlin"
    fun req(method: String, extra: String = "") =
      """{"v":1,"callId":"c-k","method":"$method","args":{}$extra}"""

    // The facade's full list, routed.
    val full = PulseContract.methods
    check(
      full == PulseContract.nativeMethods + listOf(
        "setAccount", "listDrafts", "getDraft", "countDrafts", "usage", "listNamespaces", "purge",
        "renameDraft", "deleteDraft", "setDraftContext", "upload", "cancelUpload", "retireDraft",
        "dismissReceipt", "resumeOutbox", "respondHostRequest",
      ) && full.toSet() == (PulseContract.nativeMethods + PulseContract.minor1Methods).toSet() &&
        full.size == full.toSet().size,
      k, "methods is PulseKit.swift's list: minor 0, then every minor-1 method once",
    )
    val read = PulseRouter.route(req("listDrafts"), methods = full)
    check(read is PulseRoute.Native && read.method == "listDrafts", k, "a read routes natively") {
      "$read"
    }
    val write = PulseRouter.route(req("renameDraft"), methods = full)
    check(
      write is PulseRoute.Forward && write.request.callId == "c-k", k, "a host write is forwarded",
    ) { "$write" }
    val respond = PulseRouter.route(req("respondHostRequest"), methods = full)
    check(
      respond is PulseRoute.Native, k, "respondHostRequest is native (routed to JS by the facade)",
    )
    val notListed = PulseRouter.route(req("renameDraft"))
    check(
      (notListed as? PulseRoute.Reply)?.error?.code == "method.unsupported",
      k, "with the vectors' list a write is method.unsupported",
    )
    val offDevice = PulseRouter.route(req("upload"), supported = false, methods = full)
    check(
      (offDevice as? PulseRoute.Reply)?.error?.code == "unsupported",
      k, "a write on an unsupported device is unsupported, not forwarded",
    )
    val nullContract = PulseRouter.route(req("info", ""","client":{"contract":null}"""))
    check(
      (nullContract as? PulseRoute.Reply)?.error?.code == "invalid_options",
      k, "client.contract null is invalid_options (as Swift)",
    )

    // JSON: the parser and the writer.
    check(PulseJson.parse("1.0") == PulseJson.Integer(1), k, "1.0 parses as an integer (as Swift)")
    check(PulseJson.parse("1.5e1") == PulseJson.Integer(15), k, "1.5e1 parses as an integer")
    check(
      PulseJson.parse("12345678901234567890") is PulseJson.Num,
      k, "an integer past Long is a double",
    )
    check(
      listOf("[1,]", "01", "1.", "{\"a\":1,}", "\"\\ud800\"", "\"a\tb\"", "tru", "1e400", "")
        .all { PulseJson.parse(it) == null },
      k, "strict: trailing commas, leading zeros, lone surrogates, raw tabs and overflow refused",
    )
    check(
      PulseJson.parse("{\"a\":1,\"a\":2}")?.get("a") == PulseJson.Integer(1),
      k, "a repeated key keeps its first value (as Swift)",
    )
    check(
      PulseJson.parse("[".repeat(600) + "]".repeat(600)) == null, k, "nesting past 512 is refused",
    )
    check(
      PulseJson.Str("\b\u000C\n\r\t\"\\/\u001f\u007f\u2028é").serialized ==
        "\"\\b\\f\\n\\r\\t\\\"\\\\/\\u001f\u007f\u2028é\"",
      k, "strings escape as Swift's JSONEncoder does (slashes kept)",
    )
    check(PulseJson.Str("a\uD800b").serialized == "\"a\\ud800b\"", k, "a lone surrogate is escaped")
    val swiftNumbers = listOf(
      1e16 to "1e+16", 2.5e-8 to "2.5e-08", 0.0001 to "0.0001", 1e-5 to "1e-05",
      9007199254740992.0 to "9007199254740992", 9007199254740994.0 to "9.007199254740994e+15",
      123456789012345.6 to "123456789012345.6", 0.1 + 0.2 to "0.30000000000000004",
      -2.5e-5 to "-2.5e-05",
      100.0 to "100", 1e300 to "1e+300",
    )
    val badSwift = swiftNumbers.filter { PulseJson.Num(it.first).serialized != it.second }
    check(badSwift.isEmpty(), k, "doubles print as Swift's JSONEncoder prints them") {
      badSwift.joinToString { "${it.first} -> ${PulseJson.Num(it.first).serialized}" }
    }
    val jsNumbers =
      listOf(1e16 to "10000000000000000", 1e21 to "1e+21", 1e-7 to "1e-7", 0.5 to "0.5")
    fun js(d: Double) = PulseJson.Num(d).write(style = PulseJson.NumberStyle.JS)
    val badJs = jsNumbers.filter { js(it.first) != it.second }
    check(badJs.isEmpty(), k, "doubles print as JSON.stringify prints them (for the size rule)") {
      badJs.joinToString { "${it.first} -> ${js(it.first)}" }
    }
    check(
      PulseJson.obj("b" to PulseJson.Integer(1), "a" to PulseJson.Integer(2))
        .write(sortKeys = false) == """{"b":1,"a":2}""",
      k, "objects keep insertion order unless sorted",
    )
    check(
      PulseJson.fromAny(mapOf("t" to 1763400000000L, "f" to 0.5, "n" to null, "l" to listOf(true)))
        .serialized == """{"f":0.5,"l":[true],"n":null,"t":1763400000000}""",
      k, "plain values convert, and integers stay integers",
    )

    // Envelopes.
    check(
      PulseEvent("draftsChanged", PulseJson.obj("ids" to PulseJson.Arr(emptyList()))).serialized ==
        """{"name":"draftsChanged","payload":{"ids":[]},"v":1}""",
      k, "an event envelope",
    )
    val withDetails = PulseReply.failure(
      PulseError.of(
        "restart_required", "Restart.", "c-9",
        details = PulseJson.obj("namespace" to PulseJson.Str("ns")),
      ),
    )
    check(
      withDetails.serialized ==
        """{"callId":"c-9","error":{"callId":"c-9","code":"restart_required",""" +
        """"details":{"namespace":"ns"},"message":"Restart.","recoverable":false},""" +
        """"ok":false,"v":1}""",
      k, "an error reply carries details",
    )
    check(
      PulseReply.parse(withDetails.serialized) == withDetails,
      k, "an error reply parses back to itself",
    )
    check(
      PulseReply.parse("""{"v":1,"callId":"c","ok":false,"error":{"code":"x"}}""") == null,
      k, "a reply with a malformed error doesn't parse",
    )

    // The 8 KB context rule (host-context.ts).
    fun ctx(label: String) = PulseJson.obj(
      "key" to PulseJson.Str("ticket:1"), "kind" to PulseJson.Str("ticket"),
      "label" to PulseJson.Str(label),
    )
    val overhead = PulseValidation.contextJsonBytes(ctx("")) ?: 0
    val fits = ctx("a".repeat(PulseValidation.CONTEXT_JSON_MAX_BYTES - overhead))
    val over = ctx("a".repeat(PulseValidation.CONTEXT_JSON_MAX_BYTES - overhead + 1))
    check(
      PulseValidation.contextJsonBytes(fits) == 8192 &&
        PulseValidation.checkContextSize(fits, "c") == null &&
        PulseValidation.checkContextSize(over, "c")?.code == "invalid_options",
      k, "a context of 8192 bytes fits, 8193 is invalid_options",
    )
    val accents = ctx("é".repeat((PulseValidation.CONTEXT_JSON_MAX_BYTES - overhead) / 2 + 1))
    check(
      PulseValidation.checkContextSize(accents, "c")?.code == "invalid_options",
      k, "the limit counts UTF-8 bytes, not characters",
    )
    check(
      PulseValidation.contextJsonBytes(ctx("x")) ==
        """{"kind":"ticket","label":"x"}""".length,
      k, "the key and uploadType aren't counted in the context",
    )
    val bigType = PulseJson.obj(
      "key" to PulseJson.Str("ticket:1"), "label" to PulseJson.Str("x"),
      "uploadType" to PulseJson.obj("id" to PulseJson.Str("t".repeat(9000))),
    )
    check(
      PulseValidation.checkContextSize(bigType, "c")?.code == "invalid_options",
      k, "an upload type over 8 KB is invalid_options",
    )

    // setAccount's arguments and account.json.
    val first = list(namespaceFile["vectors"]).firstOrNull() ?: PulseJson.Null
    val chosen = PulseAccountArgs.parse(
      mapOf(
        "serverOrigin" to (first["serverOrigin"] ?: PulseJson.Null),
        "userId" to (first["userId"] ?: PulseJson.Null),
        "label" to PulseJson.Str("pat"),
      ),
      first["hostId"]?.string ?: "", "c-a",
    )
    check(
      chosen is PulseAccountChoice.Account && chosen.namespace == first["namespace"]?.string &&
        chosen.serverOrigin == first["origin"]?.string && chosen.label == "pat",
      k, "setAccount's args give the vector's namespace and origin",
    ) { "$chosen" }
    check(
      PulseAccountArgs.parse(emptyMap(), "h", "c") == PulseAccountChoice.Cleared &&
        PulseAccountArgs.parse(mapOf("userId" to PulseJson.Null), "h", "c") ==
        PulseAccountChoice.Cleared,
      k, "setAccount({}) and all-null args clear the account",
    )
    val badArgs = listOf(
      mapOf("serverOrigin" to PulseJson.Str("ftp://x.org"), "userId" to PulseJson.Str("u")),
      mapOf("serverOrigin" to PulseJson.Str("https://x.org"), "userId" to PulseJson.Str("")),
      mapOf(
        "serverOrigin" to PulseJson.Str("https://x.org"), "userId" to PulseJson.Str("u"),
        "label" to PulseJson.Integer(1),
      ),
      mapOf("userId" to PulseJson.Str("u")),
    )
    check(
      badArgs.all {
        (PulseAccountArgs.parse(it, "h", "c-b") as? PulseAccountChoice.Invalid)?.error?.let { e ->
          e.code == "invalid_options" && e.callId == "c-b"
        } == true
      },
      k, "bad setAccount args are invalid_options",
    )
    val file = PulseAccountFile("com.mieweb.timehuddle", "https://huddle.example.org", null, 5, 9)
    check(
      file.serialized ==
        """{"createdAt":5,"hostId":"com.mieweb.timehuddle","lastUsedAt":9,""" +
        """"serverOrigin":"https://huddle.example.org"}""" &&
        PulseAccountFile.parse(file.serialized) == file &&
        PulseAccountFile.parse(file.copy(label = "pat").serialized)?.label == "pat" &&
        PulseAccountFile.parse("""{"hostId":"h","serverOrigin":"o","createdAt":1}""") == null,
      k, "account.json: no userId, label only when given, and it reads back",
    ) { file.serialized }

    // Busy matrix: every presenter state has its wire name, and a decision for each.
    check(
      PresenterState.values().all { PresenterState.fromWire(it.wire) == it } &&
        PulseBusy.decideOpen(null, null, PresenterState.DETACHED) == OpenDecision.BUSY,
      k, "presenter states round-trip their wire names",
    )
    check(
      PulseInboxRules.pending(
        listOf(
          PulseInboxEntry("r-2.json", 1.5), PulseInboxEntry("r-1.json", 1.25),
          PulseInboxEntry("r-3.json.native-1.part", 0.0),
        ),
      ) == listOf("r-1", "r-2"),
      k, "inbox order uses fractional seconds and skips the facade's own temp files",
    )
  }
}
