// @ts-check
// SHA256SUMS for the release zips. `swift package compute-checksum` is the SHA-256 of the file's
// bytes as lowercase hex, so the same value goes into SHA256SUMS and into Package.swift's
// `.binaryTarget(url:checksum:)`. The file is in shasum's text format, so
// `shasum -a 256 -c SHA256SUMS` (or `sha256sum -c`) checks a download.

import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * SHA-256 of a file, as lowercase hex.
 * @param {string} file
 */
export function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * The SHA256SUMS text: `<hex>  <name>` per file (two spaces: text mode), sorted by name, with a
 * trailing newline.
 * @param {{ name: string, sha256: string }[]} entries
 */
export function formatSha256Sums(entries) {
  const names = new Set();
  for (const e of entries) {
    if (!/^[0-9a-f]{64}$/.test(e.sha256))
      throw new Error(`${e.name}: "${e.sha256}" is not a SHA-256`);
    if (/[\n\\/]/.test(e.name) || e.name === '') throw new Error(`bad file name "${e.name}"`);
    if (names.has(e.name)) throw new Error(`${e.name} is listed twice`);
    names.add(e.name);
  }
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sorted.map((e) => `${e.sha256}  ${e.name}\n`).join('');
}

/**
 * Reads SHA256SUMS text back (text `  ` or binary ` *` separators).
 * @param {string} text
 */
export function parseSha256Sums(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
      if (!m) throw new Error(`bad SHA256SUMS line: ${line}`);
      return { sha256: m[1], name: m[2] };
    });
}
