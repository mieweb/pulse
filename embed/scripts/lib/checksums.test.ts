import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { formatSha256Sums, parseSha256Sums, sha256File } from './checksums.mjs';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-sums-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// FIPS 180-2 test vectors; `swift package compute-checksum` prints the same lowercase hex.
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('sha256File', () => {
  it('hashes a file’s bytes', () => {
    fs.writeFileSync(path.join(dir, 'abc'), 'abc');
    fs.writeFileSync(path.join(dir, 'empty'), '');
    expect(sha256File(path.join(dir, 'abc'))).toBe(ABC);
    expect(sha256File(path.join(dir, 'empty'))).toBe(EMPTY);
  });

  it('hashes past the 1 MiB read buffer the same as in one piece', () => {
    // 1,000,000 × 'a' is the long FIPS vector; 3 MB crosses the buffer boundary several times.
    fs.writeFileSync(path.join(dir, 'million'), 'a'.repeat(1_000_000));
    expect(sha256File(path.join(dir, 'million'))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });
});

describe('formatSha256Sums', () => {
  it('writes shasum’s text format, sorted by name, ending in a newline', () => {
    const text = formatSha256Sums([
      { name: 'hermesvm.xcframework.zip', sha256: EMPTY },
      { name: 'PulseKit.xcframework.zip', sha256: ABC },
    ]);
    expect(text).toBe(`${ABC}  PulseKit.xcframework.zip\n${EMPTY}  hermesvm.xcframework.zip\n`);
    expect(parseSha256Sums(text)).toEqual([
      { sha256: ABC, name: 'PulseKit.xcframework.zip' },
      { sha256: EMPTY, name: 'hermesvm.xcframework.zip' },
    ]);
  });

  it('refuses a bad hash, a path and a duplicate', () => {
    expect(() => formatSha256Sums([{ name: 'a.zip', sha256: ABC.toUpperCase() }])).toThrow(
      'is not a SHA-256',
    );
    expect(() => formatSha256Sums([{ name: 'dir/a.zip', sha256: ABC }])).toThrow('bad file name');
    expect(() =>
      formatSha256Sums([
        { name: 'a.zip', sha256: ABC },
        { name: 'a.zip', sha256: EMPTY },
      ]),
    ).toThrow('listed twice');
  });
});

describe('parseSha256Sums', () => {
  it('reads binary-mode lines and rejects junk', () => {
    expect(parseSha256Sums(`${ABC} *a.zip\n`)).toEqual([{ sha256: ABC, name: 'a.zip' }]);
    expect(() => parseSha256Sums('nope  a.zip\n')).toThrow('bad SHA256SUMS line');
  });
});
