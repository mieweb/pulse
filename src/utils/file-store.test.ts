import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { env } from '@/test-support/expo-fs-node';

import { deleteDraftDir, deleteSegmentFile } from './file-store';
import { holdMediaPaths } from '@/core/media-holds';

jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));

// One "device": a documents folder with a draft in it and a file beside the drafts.
const ROOT = mkdtempSync(join(tmpdir(), 'pulse-file-store-'));
const DOCS = join(ROOT, 'Documents');

beforeAll(() => {
  Object.assign(env, { docDir: DOCS, cacheDir: join(ROOT, 'Caches'), dbDir: join(DOCS, 'SQLite') });
});
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function seed() {
  mkdirSync(join(DOCS, 'drafts', 'd1', 'segments'), { recursive: true });
  writeFileSync(join(DOCS, 'drafts', 'd1', 'segments', 'c1.mp4'), 'clip');
  mkdirSync(join(DOCS, 'drafts', 'd2'), { recursive: true });
  writeFileSync(join(DOCS, 'drafts', 'd2', 'export.mp4'), 'video');
  writeFileSync(join(DOCS, 'library.db'), 'rows');
}

describe('deleteDraftDir', () => {
  it('keeps a protected legacy upload sibling and later removes it when unreferenced', () => {
    seed();
    const source = 'drafts/d1/segments/c1.mp4';
    const sibling = 'drafts/d1/segments/c1.upload.mp4';
    writeFileSync(join(DOCS, sibling), 'referenced legacy source');
    deleteSegmentFile(source, new Set([sibling]));
    expect(existsSync(join(DOCS, source))).toBe(false);
    expect(existsSync(join(DOCS, sibling))).toBe(true);
    deleteSegmentFile(source);
    expect(existsSync(join(DOCS, sibling))).toBe(false);
  });

  it('keeps held or referenced files while removing only the rest of a deleted folder', () => {
    seed();
    const clip = 'drafts/d1/segments/c1.mp4';
    writeFileSync(join(DOCS, 'drafts', 'd1', 'discard.mp4'), 'unused');
    const releaseOne = holdMediaPaths([clip]);
    const releaseTwo = holdMediaPaths([clip]);
    try {
      deleteSegmentFile(clip);
      expect(deleteDraftDir('d1')).toBe(false);
      expect(existsSync(join(DOCS, clip))).toBe(true);
      expect(existsSync(join(DOCS, 'drafts/d1/discard.mp4'))).toBe(false);
      releaseOne();
      expect(deleteDraftDir('d1')).toBe(false);
      releaseTwo();
      expect(deleteDraftDir('d1', new Set([clip]))).toBe(false);
      expect(deleteDraftDir('d1')).toBe(true);
      expect(existsSync(join(DOCS, 'drafts/d1'))).toBe(false);
    } finally {
      releaseOne();
      releaseTwo();
    }
  });

  it("deletes the draft's folder and nothing else", () => {
    seed();
    deleteDraftDir('d1');
    expect(existsSync(join(DOCS, 'drafts', 'd1'))).toBe(false);
    expect(existsSync(join(DOCS, 'drafts', 'd2', 'export.mp4'))).toBe(true);
    expect(existsSync(join(DOCS, 'library.db'))).toBe(true);
  });

  it('is a no-op for a draft with no folder', () => {
    seed();
    expect(() => deleteDraftDir('d9')).not.toThrow();
    expect(existsSync(join(DOCS, 'drafts', 'd1'))).toBe(true);
  });

  it.each([
    '..',
    '.',
    '',
    'd2/..',
    '../d2',
    'd1/segments',
    'd1\\segments',
    'd1\0',
    // Percent-encoded: a file URI decodes these to `..` or a separator.
    '%2e%2e',
    '%2E%2E',
    '.%2e',
    'd2%2f..',
    '%2e%2e%2fd2',
  ])('refuses %j, which is not one folder name, and deletes nothing', (id) => {
    seed();
    expect(() => deleteDraftDir(id)).toThrow(/Refusing to delete/);
    expect(existsSync(join(DOCS, 'drafts', 'd1', 'segments', 'c1.mp4'))).toBe(true);
    expect(existsSync(join(DOCS, 'drafts', 'd2', 'export.mp4'))).toBe(true);
    expect(existsSync(join(DOCS, 'library.db'))).toBe(true);
  });
});
