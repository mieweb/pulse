// @ts-check
// A small XML property-list reader and writer, enough for Info.plist files: the xcframework
// manifests (AvailableLibraries) and a framework's own Info.plist, where the build stamps go.
//
// Values map to JS like this: <dict> → Map (keeps key order), <array> → Array, <string> → string,
// <integer> → number (bigint past 2^53), <true/>/<false/> → boolean. <real>, <date> and <data>
// keep their text as { real }, { date } and { data } so a round trip doesn't change them.
// Binary plists (bplist00) aren't parsed here; the packaging script converts them with plutil.

/** @typedef {import('./plist-value').PlistValue} PlistValue (a JSDoc typedef can't recurse) */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** @param {string} text */
function decodeText(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return String.fromCodePoint(code);
    }
    const ch = ENTITIES[/** @type {keyof typeof ENTITIES} */ (name)];
    if (ch === undefined) throw new Error(`plist: unknown entity ${whole}`);
    return ch;
  });
}

/** @param {string} text */
function encodeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** @param {Buffer | string} input */
export function isBinaryPlist(input) {
  const head =
    typeof input === 'string' ? input.slice(0, 8) : input.subarray(0, 8).toString('latin1');
  return head.startsWith('bplist');
}

/**
 * `text` without every span from `open` to the next `close` (an unclosed one runs to the end).
 * A plain scan, so nothing removed can join with what's around it into a new `open`.
 * @param {string} text
 * @param {string} open
 * @param {string} close
 */
function cut(text, open, close) {
  let out = '';
  let at = 0;
  for (;;) {
    const start = text.indexOf(open, at);
    if (start < 0) return out + text.slice(at);
    out += text.slice(at, start);
    const end = text.indexOf(close, start + open.length);
    if (end < 0) return out;
    at = end + close.length;
  }
}

/**
 * Parses an XML plist into JS values (see the mapping at the top of this file).
 * @param {string} xml
 * @returns {PlistValue}
 */
export function parsePlist(xml) {
  if (isBinaryPlist(xml)) throw new Error('plist: binary plist; convert it to XML first');
  // Tags and the text between them. Comments, the XML declaration and the DOCTYPE are dropped.
  let body = cut(cut(xml, '<!--', '-->'), '<?', '?>');
  body = cut(body, '<!DOCTYPE', '>');
  const tokens = body.match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const END = Symbol('end');

  const nextTag = () => {
    while (i < tokens.length && !tokens[i].startsWith('<')) {
      if (tokens[i].trim() !== '') throw new Error(`plist: unexpected text "${tokens[i].trim()}"`);
      i++;
    }
    if (i >= tokens.length) throw new Error('plist: unexpected end of document');
    return tokens[i++];
  };

  /** Reads the text of a simple element whose open tag was just consumed. */
  const readText = (/** @type {string} */ name) => {
    let text = '';
    if (i < tokens.length && !tokens[i].startsWith('<')) text = tokens[i++];
    const close = tokens[i++];
    if (close !== `</${name}>`) throw new Error(`plist: expected </${name}>, got ${close}`);
    return decodeText(text);
  };

  /** @returns {PlistValue | typeof END} */
  const readValue = (/** @type {string} */ tag) => {
    const m = /^<(\/?)([A-Za-z]+)[^>]*?(\/?)>$/.exec(tag);
    if (!m) throw new Error(`plist: bad tag ${tag}`);
    const [, closing, name, selfClosing] = m;
    if (closing) return END;
    switch (name) {
      case 'dict': {
        /** @type {Map<string, PlistValue>} */
        const dict = new Map();
        if (selfClosing) return dict;
        for (;;) {
          const t = nextTag();
          if (t === '</dict>') return dict;
          if (t !== '<key>') throw new Error(`plist: expected <key> in <dict>, got ${t}`);
          const key = readText('key');
          const value = readValue(nextTag());
          if (value === END) throw new Error(`plist: key "${key}" has no value`);
          dict.set(key, value);
        }
      }
      case 'array': {
        /** @type {PlistValue[]} */
        const array = [];
        if (selfClosing) return array;
        for (;;) {
          const value = readValue(nextTag());
          if (value === END) return array;
          array.push(value);
        }
      }
      case 'string':
        return selfClosing ? '' : readText('string');
      case 'integer': {
        const text = readText('integer').trim();
        if (!/^[-+]?\d+$/.test(text)) throw new Error(`plist: bad integer "${text}"`);
        const big = BigInt(text);
        return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(big)
          : big;
      }
      case 'real':
        return { real: readText('real').trim() };
      case 'date':
        return { date: readText('date').trim() };
      case 'data':
        return { data: selfClosing ? '' : readText('data').replace(/\s+/g, '') };
      case 'true':
      case 'false':
        if (!selfClosing) readText(name);
        return name === 'true';
      default:
        throw new Error(`plist: unsupported element <${name}>`);
    }
  };
  const open = nextTag();
  if (!/^<plist\b/.test(open)) throw new Error('plist: missing <plist> root');
  const root = readValue(nextTag());
  if (root === END) throw new Error('plist: empty <plist>');
  if (nextTag() !== '</plist>') throw new Error('plist: expected </plist>');
  return root;
}

/**
 * Writes JS values as an XML plist, in the layout Xcode and plutil use (tabs, Apple's DOCTYPE).
 * @param {PlistValue} root
 */
export function buildPlist(root) {
  /** @type {string[]} */
  const lines = [];
  const emit = (/** @type {PlistValue} */ value, /** @type {string} */ indent) => {
    if (typeof value === 'string') lines.push(`${indent}<string>${encodeText(value)}</string>`);
    else if (typeof value === 'boolean') lines.push(`${indent}<${value}/>`);
    else if (typeof value === 'bigint') lines.push(`${indent}<integer>${value}</integer>`);
    else if (typeof value === 'number') {
      if (!Number.isInteger(value)) throw new Error(`plist: ${value} is not an integer`);
      lines.push(`${indent}<integer>${value}</integer>`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) return void lines.push(`${indent}<array/>`);
      lines.push(`${indent}<array>`);
      for (const item of value) emit(item, `${indent}\t`);
      lines.push(`${indent}</array>`);
    } else if (value instanceof Map) {
      if (value.size === 0) return void lines.push(`${indent}<dict/>`);
      lines.push(`${indent}<dict>`);
      for (const [key, item] of value) {
        lines.push(`${indent}\t<key>${encodeText(key)}</key>`);
        emit(item, `${indent}\t`);
      }
      lines.push(`${indent}</dict>`);
    } else if ('real' in value) lines.push(`${indent}<real>${value.real}</real>`);
    else if ('date' in value) lines.push(`${indent}<date>${value.date}</date>`);
    else if ('data' in value) lines.push(`${indent}<data>${value.data}</data>`);
    else throw new Error('plist: unsupported value');
  };
  emit(root, '');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    ...lines,
    '</plist>',
    '',
  ].join('\n');
}

/**
 * The top-level <dict> of a parsed plist.
 * @param {PlistValue} root
 * @returns {Map<string, PlistValue>}
 */
export function rootDict(root) {
  if (!(root instanceof Map)) throw new Error('plist: the root is not a <dict>');
  return root;
}
