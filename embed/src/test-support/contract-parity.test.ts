import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONTRACT_ACCOUNT,
  fakeContractMaker,
  runPulseContract,
  type PulseContractSetup,
  type PulseContractSubject,
} from '@mieweb/pulse-embed/testing';

import type { NativeBus } from './node-adapter';

// Contract parity: the host contract (runPulseContract) against the fake TimeHuddle builds on, and
// against the real Pulse JS code behind a Node stand-in for PulseKit (node-adapter.ts). Both must
// pass the same suite; where they differed, the fake was fixed (the real code is the reference).
//
// Every node subject is a fresh "device": its own folders, and its own copy of every module
// (jest.isolateModules), so each test's library, runtime, host-request channel and network source
// start empty. Native modules are the Node stand-ins (src/test-support); the rest is real.

jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: async () => ({ exists: true, md5: '00000000000000000000000000000000' }),
}));
// The Node stand-in has no change events: nothing in the runtime needs them to be right (the
// catalog is flushed before each read, and the job loop hears the outbox's own notices).
jest.mock('expo-sqlite', () => {
  const sqlite = jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
    '@/test-support/expo-sqlite-node',
  ).mockModule;
  return Object.assign(Object.create(sqlite) as object, {
    addDatabaseChangeListener: () => ({ remove: () => {} }),
  });
});
// BrownfieldMessaging: Pulse JS's sendMessage goes to the native side's listeners, and the native
// side's deliver to Pulse JS's. One bus per module registry, so one per subject.
type MockMessage = Record<string, unknown>;
type MockListener = (message: MockMessage) => void;
jest.mock('expo-brownfield', () => {
  const toJs = new Set<MockListener>();
  const toNative = new Set<MockListener>();
  return {
    sendMessage: (m: MockMessage) => [...toNative].forEach((l) => l(m)),
    addMessageListener: (l: MockListener) => {
      toJs.add(l);
      return { remove: () => void toJs.delete(l) };
    },
    mockBus: {
      deliver: (m: MockMessage) => [...toJs].forEach((l) => l(m)),
      listen: (l: MockListener) => {
        toNative.add(l);
        return () => void toNative.delete(l);
      },
    },
  };
});
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
jest.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
jest.mock('expo-crypto', () => {
  const crypto = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
    randomUUID: () => crypto.randomUUID(),
    digestStringAsync: async (_algorithm: string, data: string) =>
      crypto.createHash('sha256').update(data, 'utf8').digest('hex'),
  };
});
jest.mock('expo-secure-store', () => ({
  deleteItemAsync: async () => {},
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));
// Native media: pulse-editor isn't a jest dependency (Export's merge is played by the adapter), and
// a cover can't be made without AVFoundation (send-files.ts falls back to none).
jest.mock('@mieweb/pulse-editor', () => ({}), { virtual: true });
jest.mock('@/utils/video', () => ({ generateCoverFile: async () => false }));
// The library gate as PulseCore runs it, without its React screens: the schema migrations.
jest.mock('@/db/migrate', () => {
  // Required as the runtime loads (inside its subject's module registry), not when it runs.
  const { migrate } = jest.requireActual<typeof import('drizzle-orm/expo-sqlite/migrator')>(
    'drizzle-orm/expo-sqlite/migrator',
  );
  const { db } = jest.requireActual<typeof import('@/db/client')>('@/db/client');
  const migrations = jest.requireActual<{ default: Parameters<typeof migrate>[1] }>(
    '../../../drizzle/migrations',
  ).default;
  return { runMigrations: () => migrate(db, migrations) };
});
// Console capture rewrites the global console once per runtime; with a runtime per test it would
// stack. The log file isn't part of the contract.
jest.mock('@/features/logs/logger', () => ({ installLogCapture: () => {} }));
jest.mock('@/features/transcription/clip-queue', () => ({ clearClipQueue: async () => {} }));
jest.mock('@/features/transcription/vad', () => ({ releaseVad: async () => {} }));
jest.mock('@/features/transcription/whisper', () => ({ releaseWhisper: async () => {} }));
// The job loop's log lines and the runtime's are noise here.
jest.mock('@/features/upload/core/upload-log', () => ({
  ...jest.requireActual<typeof import('@/features/upload/core/upload-log')>(
    '@/features/upload/core/upload-log',
  ),
  uploadLog: { info: () => {}, warn: () => {} },
}));

const ROOT = mkdtempSync(join(tmpdir(), 'pulse-contract-parity-'));
let device = 0;

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** The upload server that never answers (`setup.server`), and every other request: they hang. */
function hangingFetch(_url: unknown, init?: { signal?: AbortSignal | null }): Promise<never> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
    );
  });
}

/** A fresh device: its folders, a fresh module registry, and Pulse JS booted on its library. */
async function nodeSubject(setup: PulseContractSetup): Promise<PulseContractSubject> {
  const home = join(ROOT, `device-${++device}`);
  const documents = join(home, 'Library/PulseKit/ns');
  let load!: () => Promise<Awaited<ReturnType<typeof import('./node-adapter').createNodePulse>>>;
  jest.isolateModules(() => {
    const fs = jest.requireActual<typeof import('@/test-support/expo-fs-node')>(
      '@/test-support/expo-fs-node',
    );
    Object.assign(fs.env, {
      docDir: join(home, 'App/Documents'),
      cacheDir: join(home, 'App/Caches'),
      dbDir: join(home, 'App/Documents/SQLite'),
    });
    for (const dir of [fs.env.docDir, fs.env.cacheDir, fs.env.dbDir]) {
      mkdirSync(dir, { recursive: true });
    }
    jest
      .requireActual<typeof import('@/utils/storage-root')>('@/utils/storage-root')
      .setStorageRoots({ documents, caches: join(home, 'Library/Caches/PulseKit/ns') });
    const bus = jest.requireMock<{ mockBus: NativeBus }>('expo-brownfield').mockBus;
    const adapter = jest.requireActual<typeof import('./node-adapter')>('./node-adapter');
    load = () =>
      adapter.createNodePulse({
        flows: setup.flows,
        info: setup.info,
        dropNextResult: setup.dropNextResult,
        account: CONTRACT_ACCOUNT,
        hostId: 'com.example.host',
        documents,
        bus,
      });
  });
  const pulse = await load();
  return {
    get client() {
      return pulse.client;
    },
    reload: () => pulse.reload(),
    setOnline: (online) => pulse.setOnline(online),
    dispose: () => pulse.dispose(),
  };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = hangingFetch as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('the fake', () => {
  runPulseContract(fakeContractMaker(), { describe, it, expect });
});

describe('the real Pulse JS (node adapter)', () => {
  runPulseContract(nodeSubject, { describe, it, expect });
});
