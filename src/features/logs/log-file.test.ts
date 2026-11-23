import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { env } from '@/test-support/expo-fs-node';

import {
  MAX_LOG_FILE_BYTES,
  ROLL_TARGET_BYTES,
  rewriteLogFile,
  tailWithin,
  writeLogBatch,
} from './log-file';
import { MAX_ENTRIES } from './log-buffer';
import { MAX_ENTRY_CHARS } from './redact';

jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));

const ROOT = mkdtempSync(join(tmpdir(), 'pulse-log-file-'));
const DOCS = join(ROOT, 'Documents');
const LOG = join(DOCS, 'logs', 'pulse.log');

beforeAll(() => {
  Object.assign(env, { docDir: DOCS, cacheDir: join(ROOT, 'Caches'), dbDir: join(DOCS, 'SQLite') });
});
beforeEach(() => {
  rmSync(DOCS, { recursive: true, force: true });
});
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** `n` entries of the longest kept size, numbered so the newest can be told apart. */
function bigEntries(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `#${i} `.padEnd(MAX_ENTRY_CHARS, 'x'));
}

describe('writeLogBatch', () => {
  it('rolls to a byte-bounded tail of the kept entries, so the next flush appends', () => {
    // A full buffer of 16 KB entries is ~32 MB, far past the cap.
    const kept = bigEntries(MAX_ENTRIES);
    const inFile = writeLogBatch(
      [kept[kept.length - 1]],
      () => kept,
      MAX_ENTRIES * 2, // the file is due to roll
      MAX_ENTRIES,
    );
    const size = statSync(LOG).size;
    expect(size).toBeLessThanOrEqual(ROLL_TARGET_BYTES);
    expect(inFile).toBeGreaterThan(0);
    expect(inFile).toBeLessThan(MAX_ENTRIES);
    const text = readFileSync(LOG, 'utf8');
    expect(text.endsWith(`${kept[kept.length - 1]}\n`)).toBe(true);
    expect(text.split('\n').filter(Boolean)).toEqual(kept.slice(-inFile));

    // The next small batch is appended, not another rewrite of the whole buffer.
    const after = writeLogBatch(['next'], () => [...kept, 'next'], inFile, MAX_ENTRIES);
    expect(after).toBe(inFile + 1);
    expect(readFileSync(LOG, 'utf8')).toBe(`${text}next\n`);
    expect(statSync(LOG).size).toBeLessThan(MAX_LOG_FILE_BYTES);
  });

  it('keeps every entry when the kept entries fit', () => {
    const kept = ['a', 'b', 'c'];
    expect(writeLogBatch(['c'], () => kept, MAX_ENTRIES * 2, MAX_ENTRIES)).toBe(3);
    expect(readFileSync(LOG, 'utf8')).toBe('a\nb\nc\n');
  });
});

describe('rewriteLogFile', () => {
  it('writes only the newest entries that fit, and says how many', () => {
    const entries = bigEntries(MAX_ENTRIES);
    const written = rewriteLogFile(entries);
    expect(statSync(LOG).size).toBeLessThanOrEqual(ROLL_TARGET_BYTES);
    expect(readFileSync(LOG, 'utf8').split('\n').filter(Boolean)).toEqual(entries.slice(-written));
  });
});

describe('tailWithin', () => {
  it('counts UTF-8 bytes, newline included', () => {
    // 'é' is 2 bytes, '😀' 4: each line below is 3 and 5 bytes with its newline.
    expect(tailWithin(['a', 'é', '😀'], 5)).toEqual(['😀']);
    expect(tailWithin(['a', 'é', '😀'], 8)).toEqual(['é', '😀']);
    expect(tailWithin(['a', 'é', '😀'], 10)).toEqual(['a', 'é', '😀']);
    expect(tailWithin(['a'], 1)).toEqual([]);
  });
});
