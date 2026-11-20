// Checks PulseKit's `pulse.upload` rules (embed/native/android/src/main/java/com/mieweb/pulse/kit/
// core/PulseUploadRules.kt) on a JVM, with no Android build:
//
//   gradle --offline -q -p embed/native/android/jvm-tests run \
//     -PmainClass=com.mieweb.pulse.kit.vectors.UploadRulesMain --args="$PWD"
//
// The cases are the protocol PulseKitBackground.swift answers and native-chunk-upload.ts speaks:
// each op read, a message without an id dropped, the progress throttle over a fake clock, a sweep
// across two namespaces, the PATCH's headers, and the end messages for a 204, an HTTP error and a
// cancel. Prints one line per check (`ok` or `FAIL <section>: <name>: <detail>`), the count, and
// exits 1 when any check fails.

package com.mieweb.pulse.kit.vectors

import com.mieweb.pulse.kit.core.PulseProgressThrottle
import com.mieweb.pulse.kit.core.PulseUploadCall
import com.mieweb.pulse.kit.core.PulseUploadOp
import com.mieweb.pulse.kit.core.PulseUploadRules
import kotlin.system.exitProcess

/** The upload rules runner: `main(arrayOf(repoRoot))` (the root is accepted, not read). */
object UploadRulesMain {
  private const val LIB = "/data/user/0/com.example.host/files/PulseKit"
  private const val NS_A = "acct-a"
  private const val NS_B = "acct-b"
  private const val URL = "https://vault.example.org/upload/abc"
  private val roots = listOf(LIB)

  private var passed = 0
  private var failed = 0

  private fun check(ok: Boolean, section: String, name: String, detail: () -> String = { "" }) {
    if (ok) {
      passed++
      println("ok      $section: $name")
    } else {
      failed++
      println("FAIL    $section: $name: ${detail()}")
    }
  }

  private fun <T> same(section: String, name: String, actual: T, expected: T) =
    check(actual == expected, section, name) { "expected $expected, got $actual" }

  private fun msg(vararg fields: Pair<String, Any?>): Map<String, Any?> =
    linkedMapOf<String, Any?>("type" to PulseUploadRules.TYPE).apply { putAll(fields) }

  private fun parse(vararg fields: Pair<String, Any?>) = PulseUploadRules.parse(msg(*fields), roots)

  /** A one-byte PATCH from 0 of [path]. */
  private fun patchOf(id: String, path: String) =
    parse(
      "op" to "patch",
      "id" to id,
      "url" to URL,
      "offset" to 0.0,
      "length" to 1.0,
      "path" to path,
    )

  /** Entry point; `args[0]`, when given, is the repository root. */
  @JvmStatic
  fun main(args: Array<String>) {
    if (args.size > 1) {
      println("usage: UploadRulesMain [repository root]")
      exitProcess(2)
    }
    parsing()
    dropping()
    throttling()
    sweeping()
    headers()
    ends()
    println("upload rules: $passed passed, $failed failed")
    if (failed > 0 || passed == 0) exitProcess(1)
  }

  private fun parsing() {
    val s = "parse"
    same(s, "hello", parse("op" to "hello", "id" to "h1"), PulseUploadOp.Hello("h1"))
    val file = "$LIB/$NS_A/drafts/d1/send/video.mp4"
    same(
      s,
      "patch (JS numbers are Doubles; non-string header values dropped)",
      parse(
        "op" to "patch",
        "id" to "p1",
        "url" to URL,
        "offset" to 1024.0,
        "length" to 2048.0,
        "path" to file,
        "headers" to mapOf("Authorization" to "Bearer t", "X-Bad" to 3.0),
      ),
      PulseUploadOp.Patch("p1", URL, 1024, 2048, file, NS_A, mapOf("Authorization" to "Bearer t")),
    )
    same(
      s,
      "patch without headers",
      parse(
        "op" to "patch",
        "id" to "p2",
        "url" to URL,
        "offset" to 0,
        "length" to 5L,
        "path" to file,
      ),
      PulseUploadOp.Patch("p2", URL, 0, 5, file, NS_A, emptyMap()),
    )
    val patchNeeds = "A PATCH needs url, offset, length and path."
    val badPatches =
      listOf(
        "no url" to mapOf("offset" to 0.0, "length" to 1.0, "path" to file),
        "url not http" to
          mapOf("url" to "ftp://x/y", "offset" to 0.0, "length" to 1.0, "path" to file),
        "fractional offset" to
          mapOf("url" to URL, "offset" to 1.5, "length" to 1.0, "path" to file),
        "negative offset" to mapOf("url" to URL, "offset" to -1.0, "length" to 1.0, "path" to file),
        "zero length" to mapOf("url" to URL, "offset" to 0.0, "length" to 0.0, "path" to file),
        "length a string" to mapOf("url" to URL, "offset" to 0.0, "length" to "9", "path" to file),
        "no path" to mapOf("url" to URL, "offset" to 0.0, "length" to 1.0),
      )
    for ((name, fields) in badPatches) {
      same(
        s,
        "patch refused: $name",
        parse("op" to "patch", "id" to "bad", *fields.toList().toTypedArray()),
        PulseUploadOp.Invalid("bad", patchNeeds),
      )
    }
    val outside = "/data/user/0/com.example.host/files/elsewhere/video.mp4"
    same(
      s,
      "patch refused: file outside every namespace",
      patchOf("o", outside),
      PulseUploadOp.Invalid("o", "$outside isn't in a PulseKit namespace."),
    )
    val shared = "$LIB/.shared/models/ggml.bin"
    same(
      s,
      "patch refused: .shared isn't a namespace",
      patchOf("m", shared),
      PulseUploadOp.Invalid("m", "$shared isn't in a PulseKit namespace."),
    )
    val escaping = "$LIB/$NS_A/../../secret"
    same(
      s,
      "patch refused: .. out of the library",
      patchOf("e", escaping),
      PulseUploadOp.Invalid("e", "$escaping isn't in a PulseKit namespace."),
    )
    same(
      s,
      "attach",
      parse("op" to "attach", "id" to "a1", "url" to URL, "path" to file),
      PulseUploadOp.Attach("a1", URL, file, NS_A),
    )
    same(
      s,
      "attach refused without a namespace path",
      parse("op" to "attach", "id" to "a2", "url" to URL, "path" to "/tmp/x"),
      PulseUploadOp.Invalid("a2", "An attach needs url, and a path in a PulseKit namespace."),
    )
    same(s, "cancel", parse("op" to "cancel", "id" to "p1"), PulseUploadOp.Cancel("p1"))
    same(
      s,
      "sweep (non-string live entries dropped)",
      parse("op" to "sweep", "id" to "s1", "root" to "$LIB/$NS_A", "live" to listOf(URL, 4.0)),
      PulseUploadOp.Sweep("s1", "$LIB/$NS_A", NS_A, setOf(URL)),
    )
    same(
      s,
      "sweep without live sweeps everything of the namespace",
      parse("op" to "sweep", "id" to "s2", "root" to "file://$LIB/$NS_B/"),
      PulseUploadOp.Sweep("s2", "file://$LIB/$NS_B/", NS_B, emptySet()),
    )
    same(
      s,
      "sweep refused without a namespace root",
      parse("op" to "sweep", "id" to "s3", "root" to LIB),
      PulseUploadOp.Invalid("s3", "A sweep needs the documents folder of a PulseKit namespace."),
    )
    same(
      s,
      "unknown op",
      parse("op" to "rewind", "id" to "u1"),
      PulseUploadOp.Invalid("u1", "Unknown upload operation rewind."),
    )
    same(
      s,
      "second library root (no_backup) is a namespace too",
      PulseUploadRules.namespaceOf(
        "/data/user/0/h/no_backup/PulseKit/$NS_B/x.mp4",
        listOf(LIB, "/data/user/0/h/no_backup/PulseKit"),
      ),
      NS_B,
    )
  }

  private fun dropping() {
    val s = "drop"
    same(s, "missing id", parse("op" to "hello"), null)
    same(s, "non-string id", parse("op" to "hello", "id" to 7.0), null)
    same(s, "missing op", parse("id" to "x"), null)
    same(
      s,
      "another message type",
      PulseUploadRules.parse(mapOf("type" to "pulse.cmd", "op" to "hello", "id" to "x"), roots),
      null,
    )
    same(
      s,
      "an answer echoed back",
      PulseUploadRules.parse(PulseUploadRules.endOk("x"), roots),
      null,
    )
  }

  private fun throttling() {
    val s = "throttle"
    val t = PulseProgressThrottle()
    // A tick every 10 ms for one second (ms 0..990): at most 4 go out, the first at once.
    val sent = ArrayList<Pair<Long, Long>>()
    for (ms in 0L until 1000L step 10L) {
      t.offer("p1", ms * 100, ms)?.let { sent.add(ms to it) }
    }
    same(s, "4 messages in the first second", sent.size, 4)
    same(s, "the first tick goes at once", sent.firstOrNull(), 0L to 0L)
    same(s, "then every 250 ms", sent.map { it.first }, listOf(0L, 250L, 500L, 750L))
    check(
      sent.zipWithNext().all { (a, b) ->
        b.first - a.first >= PulseUploadRules.PROGRESS_INTERVAL_MS
      },
      s,
      "never two within 250 ms",
    ) { sent.toString() }
    same(s, "flush hands over the last value held back", t.flush("p1"), 99_000L)
    same(s, "flush again has nothing", t.flush("p1"), null)
    // Another id has its own clock.
    same(s, "another id isn't held by p1's clock", t.offer("p2", 5, 990), 5L)
    same(s, "p2's second tick inside 250 ms is held", t.offer("p2", 6, 1100), null)
    same(s, "p2 at 250 ms goes", t.offer("p2", 7, 1240), 7L)
    same(s, "nothing held after a tick went", t.flush("p2"), null)
    t.forget("p1")
    same(s, "a forgotten id starts afresh", t.offer("p1", 1, 1000), 1L)
    same(s, "flush of an unknown id", t.flush("zzz"), null)
  }

  private fun sweeping() {
    val s = "sweep"
    val a = "$LIB/$NS_A/drafts"
    val b = "$LIB/$NS_B/drafts"
    val calls =
      listOf(
        PulseUploadCall("$URL/a-live", "$a/d1/send/video.mp4"),
        PulseUploadCall("$URL/a-dead", "$a/d2/send/video.mp4"),
        PulseUploadCall("$URL/a-dead2", "$a/d3/send/thumb.jpg"),
        PulseUploadCall("$URL/b-dead", "$b/d4/send/video.mp4"),
        PulseUploadCall("$URL/b-live", "$b/d5/send/video.mp4"),
      )
    val live = setOf("$URL/a-live", "$URL/b-live")
    same(
      s,
      "namespace A: only A's calls of no live job",
      PulseUploadRules.sweep(calls, "$LIB/$NS_A", live).map { it.url },
      listOf("$URL/a-dead", "$URL/a-dead2"),
    )
    same(
      s,
      "namespace B: only B's calls of no live job",
      PulseUploadRules.sweep(calls, "$LIB/$NS_B/", live).map { it.url },
      listOf("$URL/b-dead"),
    )
    same(
      s,
      "an empty live list sweeps every call of the namespace",
      PulseUploadRules.sweep(calls, "$LIB/$NS_B", emptySet()).map { it.url },
      listOf("$URL/b-dead", "$URL/b-live"),
    )
    same(
      s,
      "a namespace whose name extends another's isn't swept with it",
      PulseUploadRules.sweep(
        listOf(PulseUploadCall("$URL/x", "$LIB/${NS_A}x/v.mp4")),
        "$LIB/$NS_A",
        emptySet(),
      ),
      emptyList<PulseUploadCall>(),
    )
    same(s, "isUnder: the root itself isn't under it", PulseUploadRules.isUnder(a, a), false)
    val dotted = PulseUploadRules.isUnder("$a/../../$NS_B/v", "$LIB/$NS_B")
    same(s, "isUnder: .. resolved", dotted, true)
  }

  private fun headers() {
    val s = "headers"
    same(
      s,
      "PATCH headers from offset and length, JS's own kept",
      PulseUploadRules.patchHeaders(
        mapOf(
          "Authorization" to "Bearer t",
          "upload-offset" to "1",
          "content-type" to "text/plain",
          "Content-Length" to "999",
        ),
        offset = 4096,
        length = 1_000_000,
      ),
      mapOf(
        "Authorization" to "Bearer t",
        "Tus-Resumable" to "1.0.0",
        "Upload-Offset" to "4096",
        "Content-Type" to "application/offset+octet-stream",
        "Content-Length" to "1000000",
      ),
    )
    same(
      s,
      "JS's Tus-Resumable kept, under one name",
      PulseUploadRules.patchHeaders(mapOf("tus-resumable" to "1.0.0-x"), 0, 1)["Tus-Resumable"],
      "1.0.0-x",
    )
    same(
      s,
      "repeated response headers joined",
      PulseUploadRules.responseHeaders(
        mapOf("Upload-Offset" to listOf("100"), "Via" to listOf("a", "b")),
      ),
      mapOf("Upload-Offset" to "100", "Via" to "a, b"),
    )
    same(s, "sent: a PATCH from 100 after 50 bytes", PulseUploadRules.sentFor(100, 50, 100), 50L)
    same(s, "sent: attach sees the upload's offset", PulseUploadRules.sentFor(100, 50, 0), 150L)
    same(s, "sent: never negative", PulseUploadRules.sentFor(100, 0, 400), 0L)
  }

  private fun ends() {
    val s = "end"
    same(
      s,
      "progress",
      PulseUploadRules.progress("p1", 1234),
      mapOf("type" to "pulse.upload.progress", "id" to "p1", "sent" to 1234.0),
    )
    same(
      s,
      "hello",
      PulseUploadRules.endOk("h1"),
      mapOf("type" to "pulse.upload.end", "id" to "h1", "ok" to true),
    )
    same(
      s,
      "204",
      PulseUploadRules.endResponse("p1", 204, mapOf("Upload-Offset" to "100")),
      mapOf(
        "type" to "pulse.upload.end",
        "id" to "p1",
        "ok" to true,
        "status" to 204,
        "headers" to mapOf("Upload-Offset" to "100"),
      ),
    )
    same(
      s,
      "HTTP error is an answer (ok, the status says it)",
      PulseUploadRules.endResponse("p1", 409, emptyMap()),
      mapOf(
        "type" to "pulse.upload.end",
        "id" to "p1",
        "ok" to true,
        "status" to 409,
        "headers" to emptyMap<String, String>(),
      ),
    )
    same(
      s,
      "cancel",
      PulseUploadRules.endCancelled("p1"),
      mapOf(
        "type" to "pulse.upload.end",
        "id" to "p1",
        "ok" to false,
        "error" to mapOf("message" to "Cancelled.", "canceled" to true),
      ),
    )
    same(
      s,
      "network failure (not cancelled: JS resumes)",
      PulseUploadRules.endFailed("p1", "timeout"),
      mapOf(
        "type" to "pulse.upload.end",
        "id" to "p1",
        "ok" to false,
        "error" to mapOf("message" to "timeout", "canceled" to false),
      ),
    )
    same(
      s,
      "attach with nothing running",
      PulseUploadRules.endNotAttached("a1"),
      mapOf("type" to "pulse.upload.end", "id" to "a1", "ok" to true, "attached" to false),
    )
    same(
      s,
      "sweep",
      PulseUploadRules.endSwept("s1", 2),
      mapOf("type" to "pulse.upload.end", "id" to "s1", "ok" to true, "cancelled" to 2),
    )
  }
}
