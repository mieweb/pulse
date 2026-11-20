import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));

type Roots = typeof import('./storage-root');
type Fs = typeof import('@/test-support/expo-fs-node');
type StorageRoots = import('./storage-root').StorageRoots;

// Each test gets a fresh module: the roots are set once per runtime.
let roots!: Roots;
let base!: string;

beforeEach(() => {
  jest.resetModules();
  base = mkdtempSync(join(tmpdir(), 'pulse-storage-root-'));
  const fs = jest.requireActual<Fs>('@/test-support/expo-fs-node');
  fs.env.docDir = join(base, 'App/Documents');
  fs.env.cacheDir = join(base, 'App/Caches');
  roots = jest.requireActual<Roots>('./storage-root');
});

type Change = [string, Partial<StorageRoots>];

const ns = () => ({
  documents: join(base, 'Library/PulseKit/com.example.host-0123456789abcdef'),
  caches: join(base, 'Library/Caches/PulseKit/com.example.host-0123456789abcdef'),
  models: join(base, 'Library/PulseKit/.shared/models'),
});

describe('setStorageRoots', () => {
  it('uses the given folders, creating them', () => {
    const r = ns();
    roots.setStorageRoots(r);
    expect(roots.documentDir().uri).toBe(`file://${r.documents}/`);
    expect(roots.cacheDir().uri).toBe(`file://${r.caches}/`);
    expect(roots.modelsDir().uri).toBe(`file://${r.models}/`);
    expect(roots.customDocumentsPath()).toBe(r.documents);
    for (const dir of [r.documents, r.caches, r.models]) expect(existsSync(dir)).toBe(true);
  });

  it('is a no-op for the same roots again, as paths or file:// URIs with trailing slashes', () => {
    const r = ns();
    roots.setStorageRoots(r);
    roots.documentDir();
    expect(() =>
      roots.setStorageRoots({
        documents: `file://${r.documents}/`,
        caches: `${r.caches}/`,
        models: `file://${r.models}`,
      }),
    ).not.toThrow();
    expect(roots.modelsDir().uri).toBe(`file://${r.models}/`);
  });

  it('treats a missing models root as its default, models/ in documents', () => {
    const { documents, caches } = ns();
    roots.setStorageRoots({ documents, caches });
    expect(roots.modelsDir().uri).toBe(`file://${documents}/models/`);
    expect(existsSync(join(documents, 'models'))).toBe(true);
    expect(() =>
      roots.setStorageRoots({ documents, caches, models: join(documents, 'models') }),
    ).not.toThrow();
  });

  it.each<Change>([
    ['documents', { documents: '/elsewhere/PulseKit/b' }],
    ['caches', { caches: '/elsewhere/Caches/b' }],
    ['models', { models: '/elsewhere/models' }],
  ])('throws when %s differs from the roots already set', (_field, change) => {
    const r = ns();
    roots.setStorageRoots(r);
    expect(() => roots.setStorageRoots({ ...r, ...change })).toThrow(
      'Pulse already opened its library in another folder.',
    );
    expect(roots.modelsDir().uri).toBe(`file://${r.models}/`);
  });

  it('throws when models was left to its default and is now another folder', () => {
    const { documents, caches, models } = ns();
    roots.setStorageRoots({ documents, caches });
    expect(() => roots.setStorageRoots({ documents, caches, models })).toThrow(
      'Pulse already opened its library in another folder.',
    );
  });

  it('throws when set after Pulse read a folder', () => {
    roots.modelsDir();
    expect(() => roots.setStorageRoots(ns())).toThrow(
      'Set the storage roots before Pulse opens its library.',
    );
  });

  it.each<Change>([
    ['a relative documents root', { documents: 'Library/PulseKit/ns' }],
    ['a relative caches root', { caches: 'Caches/ns' }],
    ['a relative models root', { models: 'models' }],
    ['a space', { documents: '/var/Application Support/ns' }],
    ['a %', { caches: '/var/Caches/a%20b' }],
    ['a #', { models: '/var/models#1' }],
    ['a ?', { models: '/var/models?x' }],
  ])('rejects %s', (_name, change) => {
    expect(() => roots.setStorageRoots({ ...ns(), ...change })).toThrow();
    // Nothing was set: the next valid call still works.
    const r = ns();
    roots.setStorageRoots(r);
    expect(roots.documentDir().uri).toBe(`file://${r.documents}/`);
  });
});

describe('without roots (the Pulse app)', () => {
  it('uses the app folders, with the models in Documents/models', () => {
    expect(roots.documentDir().uri).toBe(`file://${join(base, 'App/Documents')}/`);
    expect(roots.cacheDir().uri).toBe(`file://${join(base, 'App/Caches')}/`);
    expect(roots.modelsDir().uri).toBe(`file://${join(base, 'App/Documents/models')}/`);
    expect(roots.customDocumentsPath()).toBeNull();
  });
});
