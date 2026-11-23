// Mirrors embed/native/ios/PulseKitEnvelope.swift (`JSONValue`): the one JSON value type the
// facade uses for every envelope, result file and catalog row. Plain Kotlin (kotlin.* and java.*
// only), so it runs on a Mac JVM against the shared vectors (embed/native/android/jvm-tests).
//
// Not org.json: Android's org.json and the JVM's differ on numbers, and the vectors pin that
// integers stay integers (times are integer milliseconds). Nothing else in PulseKit parses JSON.
//
// Android differences from the Swift type, none of which a host can see:
// - Objects keep insertion order (Swift's dictionary has none); `serialized` sorts keys as Swift's
//   `.sortedKeys` does, so the text is the same.
// - Kotlin strings can hold a lone UTF-16 surrogate, which a Swift String can't. The parser refuses
//   a `\uD800`-style escape without its pair (as JSONDecoder does) and the writer escapes a lone
//   surrogate as `\uXXXX`.

package com.mieweb.pulse.kit.core

import java.math.BigDecimal

/**
 * Any JSON value. A number whose value is a whole number that fits a Long parses as [Integer]
 * (`1`, `1.0` and `1e0` alike, as Swift's decoder does), anything else as [Num].
 */
sealed class PulseJson {
  /** JSON `null`. */
  object Null : PulseJson() {
    override fun toString(): String = "Null"
  }

  /** `true` or `false`. */
  data class Bool(val value: Boolean) : PulseJson()

  /** A whole number. Writes without a fraction or exponent. */
  data class Integer(val value: Long) : PulseJson()

  /** Any other number. Always finite: the parser refuses what a Double can't hold. */
  data class Num(val value: Double) : PulseJson()

  /** A string. */
  data class Str(val value: String) : PulseJson()

  /** An array. */
  data class Arr(val items: List<PulseJson>) : PulseJson()

  /** An object, in insertion order. Equality ignores the order, as Swift's does. */
  data class Obj(val fields: Map<String, PulseJson>) : PulseJson()

  /** The field `key` of an object; null when this isn't an object or has no such field. */
  operator fun get(key: String): PulseJson? = (this as? Obj)?.fields?.get(key)

  /** This object's fields, or null. */
  val obj: Map<String, PulseJson>? get() = (this as? Obj)?.fields

  /** This array's items, or null. */
  val array: List<PulseJson>? get() = (this as? Arr)?.items

  /** This string, or null. */
  val string: String? get() = (this as? Str)?.value

  /** This boolean, or null. */
  val bool: Boolean? get() = (this as? Bool)?.value

  /** A whole number, from an [Integer] or a [Num] without a fraction (|n| < 9e15), else null. */
  val integer: Long?
    get() = when (this) {
      is Integer -> value
      is Num -> if (Math.rint(value) == value && Math.abs(value) < 9.0e15) value.toLong() else null
      else -> null
    }

  /** Compact JSON with sorted keys, so the same value always prints the same text (Swift's). */
  val serialized: String get() = write(sortKeys = true, style = NumberStyle.SWIFT)

  /**
   * Compact JSON. [sortKeys] sorts object keys by UTF-16 code unit; otherwise insertion order.
   * [style] picks how a [Num] prints: as Swift's JSONEncoder does (the default) or as
   * JavaScript's `JSON.stringify` does (for measuring what Pulse JS will store).
   */
  fun write(sortKeys: Boolean = true, style: NumberStyle = NumberStyle.SWIFT): String {
    val out = StringBuilder()
    PulseJsonWriter(out, sortKeys, style).value(this)
    return out.toString()
  }

  /** For APIs that take plain values: Map, List, String, Long, Double, Boolean or null. */
  fun toAny(): Any? = when (this) {
    Null -> null
    is Bool -> value
    is Integer -> value
    is Num -> value
    is Str -> value
    is Arr -> items.map { it.toAny() }
    is Obj -> LinkedHashMap<String, Any?>().also { m ->
      fields.forEach { (k, v) -> m[k] = v.toAny() }
    }
  }

  /** How a [Num] prints. */
  enum class NumberStyle {
    /**
     * Swift's JSONEncoder: shortest digits; exponent form below 1e-4 or above 2^53, with at least
     * two exponent digits (`2.5e-08`, `1e+16`); a whole value loses its `.0`.
     */
    SWIFT,

    /** JavaScript's `Number.prototype.toString`: exponent form below 1e-6 or from 1e21 (`1e-7`). */
    JS,
  }

  /** Parsing and conversion. */
  companion object {
    /** The deepest nesting the parser accepts; deeper text is refused rather than overflowing. */
    const val MAX_DEPTH = 512

    /** Parse JSON text; null when it isn't JSON (strict RFC 8259, no trailing commas). */
    @JvmStatic
    fun parse(text: String): PulseJson? = PulseJsonParser(text).parseDocument()

    /** Shorthand for a string value. */
    @JvmStatic
    fun of(value: String?): PulseJson = if (value == null) Null else Str(value)

    /** Shorthand for a whole number. */
    @JvmStatic
    fun of(value: Long): PulseJson = Integer(value)

    /** Shorthand for a boolean. */
    @JvmStatic
    fun of(value: Boolean): PulseJson = Bool(value)

    /** An object from pairs, in order. */
    @JvmStatic
    fun obj(vararg pairs: Pair<String, PulseJson>): PulseJson = Obj(linkedMapOf(*pairs))

    /**
     * From plain values (what a messaging bridge or a Bundle hands over). Byte, Short, Int and
     * Long become [Integer]; Float and Double become [Num] (or [Null] when not finite), as Swift's
     * `JSONValue(any:)` keeps a float a double. Anything JSON can't hold becomes [Null].
     */
    @JvmStatic
    fun fromAny(any: Any?): PulseJson = when (any) {
      null -> Null
      is PulseJson -> any
      is Boolean -> Bool(any)
      is Byte -> Integer(any.toLong())
      is Short -> Integer(any.toLong())
      is Int -> Integer(any.toLong())
      is Long -> Integer(any)
      is Float -> if (any.isFinite()) Num(any.toDouble()) else Null
      is Double -> if (any.isFinite()) Num(any) else Null
      is CharSequence -> Str(any.toString())
      is Map<*, *> -> {
        val m = LinkedHashMap<String, PulseJson>()
        for ((k, v) in any) if (k is String) m[k] = fromAny(v)
        Obj(m)
      }
      is Iterable<*> -> Arr(any.map { fromAny(it) })
      is Array<*> -> Arr(any.map { fromAny(it) })
      else -> Null
    }
  }
}

/** The writer behind [PulseJson.write]. */
private class PulseJsonWriter(
  private val out: StringBuilder,
  private val sortKeys: Boolean,
  private val style: PulseJson.NumberStyle,
) {
  fun value(v: PulseJson) {
    when (v) {
      PulseJson.Null -> out.append("null")
      is PulseJson.Bool -> out.append(if (v.value) "true" else "false")
      is PulseJson.Integer -> out.append(v.value)
      is PulseJson.Num -> out.append(formatNumber(v.value, style))
      is PulseJson.Str -> string(v.value)
      is PulseJson.Arr -> {
        out.append('[')
        v.items.forEachIndexed { i, item ->
          if (i > 0) out.append(',')
          value(item)
        }
        out.append(']')
      }
      is PulseJson.Obj -> {
        out.append('{')
        val keys = if (sortKeys) v.fields.keys.sorted() else v.fields.keys.toList()
        keys.forEachIndexed { i, key ->
          if (i > 0) out.append(',')
          string(key)
          out.append(':')
          value(v.fields.getValue(key))
        }
        out.append('}')
      }
    }
  }

  /** Escapes as JSONEncoder does with `.withoutEscapingSlashes` (and as JSON.stringify does). */
  fun string(s: String) {
    out.append('"')
    var i = 0
    while (i < s.length) {
      val c = s[i]
      when {
        c == '"' -> out.append("\\\"")
        c == '\\' -> out.append("\\\\")
        c == '\b' -> out.append("\\b")
        c == '\u000C' -> out.append("\\f")
        c == '\n' -> out.append("\\n")
        c == '\r' -> out.append("\\r")
        c == '\t' -> out.append("\\t")
        c < ' ' -> hex(c)
        Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
          out.append(c).append(s[i + 1])
          i++
        }
        Character.isSurrogate(c) -> hex(c)
        else -> out.append(c)
      }
      i++
    }
    out.append('"')
  }

  private fun hex(c: Char) {
    out.append("\\u")
    val h = c.code.toString(16)
    repeat(4 - h.length) { out.append('0') }
    out.append(h)
  }
}

/** A finite double as [style] prints it. */
internal fun formatNumber(d: Double, style: PulseJson.NumberStyle): String {
  if (!d.isFinite()) return "null"
  if (d == 0.0) {
    return if (style == PulseJson.NumberStyle.SWIFT && 1.0 / d < 0) "-0" else "0"
  }
  // Double.toString gives the digits that round-trip; BigDecimal splits them from the exponent.
  val bd = BigDecimal(d.toString()).stripTrailingZeros()
  val digits = bd.unscaledValue().abs().toString()
  // d = 0.digits × 10^(exp + 1), i.e. the first digit is at 10^exp.
  val exp = digits.length - 1 - bd.scale()
  val abs = Math.abs(d)
  val exponential = when (style) {
    PulseJson.NumberStyle.SWIFT -> abs < 1e-4 || abs > 9007199254740992.0
    PulseJson.NumberStyle.JS -> abs < 1e-6 || abs >= 1e21
  }
  val sign = if (d < 0) "-" else ""
  if (!exponential) return sign + bd.abs().toPlainString()
  val mantissa = if (digits.length == 1) digits else digits[0] + "." + digits.substring(1)
  val e = Math.abs(exp).toString()
  val expText = when (style) {
    PulseJson.NumberStyle.SWIFT -> (if (exp < 0) "-" else "+") + (if (e.length < 2) "0$e" else e)
    PulseJson.NumberStyle.JS -> (if (exp < 0) "-" else "+") + e
  }
  return sign + mantissa + "e" + expText
}

/** A strict recursive-descent parser over the text's UTF-16 units. */
private class PulseJsonParser(private val s: String) {
  private var i = 0

  fun parseDocument(): PulseJson? = try {
    skipSpace()
    val v = value(0)
    skipSpace()
    if (i == s.length) v else null
  } catch (_: Bad) {
    null
  }

  /** Any refusal; caught once at the top. */
  private class Bad : Exception() {
    override fun fillInStackTrace(): Throwable = this
  }

  private fun fail(): Nothing = throw Bad()

  private fun skipSpace() {
    while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++
  }

  private fun value(depth: Int): PulseJson {
    if (depth > PulseJson.MAX_DEPTH || i >= s.length) fail()
    return when (s[i]) {
      '{' -> obj(depth)
      '[' -> arr(depth)
      '"' -> PulseJson.Str(string())
      't' -> literal("true", PulseJson.Bool(true))
      'f' -> literal("false", PulseJson.Bool(false))
      'n' -> literal("null", PulseJson.Null)
      else -> number()
    }
  }

  private fun literal(word: String, v: PulseJson): PulseJson {
    if (!s.startsWith(word, i)) fail()
    i += word.length
    return v
  }

  private fun obj(depth: Int): PulseJson {
    i++
    val fields = LinkedHashMap<String, PulseJson>()
    skipSpace()
    if (i < s.length && s[i] == '}') {
      i++
      return PulseJson.Obj(fields)
    }
    while (true) {
      skipSpace()
      if (i >= s.length || s[i] != '"') fail()
      val key = string()
      skipSpace()
      if (i >= s.length || s[i] != ':') fail()
      i++
      skipSpace()
      val v = value(depth + 1)
      // A repeated key keeps its first value, as Swift's decoder does.
      if (!fields.containsKey(key)) fields[key] = v
      skipSpace()
      if (i >= s.length) fail()
      when (s[i]) {
        ',' -> i++
        '}' -> {
          i++
          return PulseJson.Obj(fields)
        }
        else -> fail()
      }
    }
  }

  private fun arr(depth: Int): PulseJson {
    i++
    val items = ArrayList<PulseJson>()
    skipSpace()
    if (i < s.length && s[i] == ']') {
      i++
      return PulseJson.Arr(items)
    }
    while (true) {
      skipSpace()
      items.add(value(depth + 1))
      skipSpace()
      if (i >= s.length) fail()
      when (s[i]) {
        ',' -> i++
        ']' -> {
          i++
          return PulseJson.Arr(items)
        }
        else -> fail()
      }
    }
  }

  private fun string(): String {
    i++ // the opening quote
    val out = StringBuilder()
    while (true) {
      if (i >= s.length) fail()
      val c = s[i++]
      when {
        c == '"' -> return out.toString()
        c == '\\' -> {
          if (i >= s.length) fail()
          when (s[i++]) {
            '"' -> out.append('"')
            '\\' -> out.append('\\')
            '/' -> out.append('/')
            'b' -> out.append('\b')
            'f' -> out.append('\u000C')
            'n' -> out.append('\n')
            'r' -> out.append('\r')
            't' -> out.append('\t')
            'u' -> {
              val unit = hex4()
              if (Character.isHighSurrogate(unit)) {
                if (!s.startsWith("\\u", i)) fail()
                i += 2
                val low = hex4()
                if (!Character.isLowSurrogate(low)) fail()
                out.append(unit).append(low)
              } else if (Character.isLowSurrogate(unit)) {
                fail()
              } else {
                out.append(unit)
              }
            }
            else -> fail()
          }
        }
        c < ' ' -> fail()
        else -> out.append(c)
      }
    }
  }

  private fun hex4(): Char {
    if (i + 4 > s.length) fail()
    var v = 0
    for (k in 0 until 4) {
      val d = Character.digit(s[i + k], 16)
      if (d < 0) fail()
      v = v * 16 + d
    }
    i += 4
    return v.toChar()
  }

  private fun number(): PulseJson {
    val start = i
    if (i < s.length && s[i] == '-') i++
    if (i >= s.length) fail()
    if (s[i] == '0') {
      i++
    } else if (s[i] in '1'..'9') {
      while (i < s.length && s[i] in '0'..'9') i++
    } else {
      fail()
    }
    var plain = true
    if (i < s.length && s[i] == '.') {
      plain = false
      i++
      if (i >= s.length || s[i] !in '0'..'9') fail()
      while (i < s.length && s[i] in '0'..'9') i++
    }
    if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
      plain = false
      i++
      if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
      if (i >= s.length || s[i] !in '0'..'9') fail()
      while (i < s.length && s[i] in '0'..'9') i++
    }
    val text = s.substring(start, i)
    if (plain) text.toLongOrNull()?.let { return PulseJson.Integer(it) }
    val d = text.toDouble()
    if (!d.isFinite()) fail()
    // Whole numbers that fit a Long are integers, however they were written ("1.0", "1e2"),
    // as Swift's JSONValue decodes them. The exact check is skipped for huge exponents, which
    // would make BigDecimal slow and can't give a whole Long anyway.
    val e = text.indexOfFirst { it == 'e' || it == 'E' }
    val exponent = if (e < 0) 0 else text.substring(e + 1).toIntOrNull() ?: Int.MAX_VALUE
    if (!plain && Math.rint(d) == d && Math.abs(d) < 9.2e18 && Math.abs(exponent) <= 400) {
      val exact = try {
        BigDecimal(text).toBigIntegerExact()
      } catch (_: ArithmeticException) {
        null
      }
      if (exact != null && exact.bitLength() < 64) return PulseJson.Integer(exact.toLong())
    }
    return PulseJson.Num(d)
  }
}
