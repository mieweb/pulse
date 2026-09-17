/**
 * Characterization tests for the BackgroundUploadManager singleton — the
 * app's most safety-critical untested state machine. Everything effectful
 * (DB, secure store, native files, transports, notifications, the Android
 * foreground service) is mocked at the module boundary; the tests pin the
 * ORCHESTRATION: queueing, token gating, duplicate-destination guarding,
 * transport selection, completion persistence, cancellation, and mutation
 * invalidation. The wire behavior under these transports is covered by
 * tus-client/direct-client unit tests and the pv-integration suite.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// ---- module-boundary mocks (hoisted by jest above the imports below) ----

// Shared state lives INSIDE the factory (exposed as `__state`) because the
// manager registers its invalidation hook at import time — before any
// test-file const would initialize (TDZ).
jest.mock('@/db/drafts', () => {
  // Deliberately untyped: babel-plugin-jest-hoist walks TS annotations inside
  // factories and rejects any identifier they contain. The importing side
  // re-types this via the `__state` cast below the imports.
  const state = {
    uploadProgress: [] as unknown[],
    resumeUrls: [] as unknown[],
    invalidationHook: null as unknown,
  };
  return {
    __state: state,
    getDraftName: jest.fn(async () => 'My Draft'),
    getDraftUploadStatus: jest.fn(async () => null),
    getResumableDrafts: jest.fn(async () => []),
    getUploadArtifact: jest.fn(async () => null),
    clearUploadResumeRows: jest.fn(async () => {}),
    otherDraftPairedTo: jest.fn(async () => null),
    draftQuery: jest.fn(() => []),
    listUploadResumeUrls: jest.fn(async () => state.resumeUrls),
    registerUploadInvalidationHook: jest.fn((hook) => {
      state.invalidationHook = hook;
    }),
    segmentsForDraft: jest.fn(async () => []),
    setCaptionsUploadStatus: jest.fn(async () => {}),
    setUploadMerged: jest.fn(async () => {}),
    setUploadProgress: jest.fn(async (id, patch) => {
      state.uploadProgress.push({ draftId: id, patch });
    }),
    upsertUploadArtifact: jest.fn(async () => {}),
  };
});

jest.mock('@/db/destinations', () => ({
  deleteDestination: jest.fn(async () => {}),
  getDestinationIdByArtifactId: jest.fn(async () => null),
}));

jest.mock('@/db/secure-token', () => ({ getDraftToken: jest.fn(async () => 'tok') }));
jest.mock('@/db/transcripts', () => ({ getDraftTranscriptRow: jest.fn(async () => null) }));
jest.mock('@/features/transcription/vtt', () => ({ linesToVtt: jest.fn(() => '') }));
jest.mock('@/features/transcription/whisper', () => ({ parseTranscriptLines: jest.fn(() => []) }));
jest.mock('@/utils/contract-gate', () => ({ conformToContract: jest.fn(async () => null) }));
jest.mock('@/utils/video', () => ({ generateThumbnailFile: jest.fn(async () => false) }));
jest.mock('@/utils/file-store', () => ({
  absolutize: (p: string) => `/abs/${p}`,
  toFileUri: (p: string) => (p.startsWith('file://') ? p : `file://${p}`),
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));

jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    name: string;
    exists = true;
    size = 1024;
    constructor(...parts: unknown[]) {
      this.uri = String(parts[parts.length - 1] ?? 'mock');
      this.name = this.uri.split('/').pop() ?? 'mock';
    }
    write() {}
    delete() {}
  }
  class MockDirectory {
    create() {}
  }
  return { Directory: MockDirectory, File: MockFile, Paths: { cache: '/cache' } };
});
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, md5: 'deadbeef' })),
}));

jest.mock('./keep-alive', () => ({
  keepAlive: { begin: jest.fn(async () => {}), end: jest.fn(async () => {}), note: jest.fn() },
}));
jest.mock('./notify', () => ({
  uploadNotify: {
    ensurePermission: jest.fn(async () => {}),
    complete: jest.fn(async () => {}),
    failed: jest.fn(async () => {}),
  },
}));

const mockTusRun = jest.fn<(params: Record<string, unknown>) => Promise<{ resourceUrl: string }>>();
const mockTusCancel = jest.fn<(url: string, token: string | null) => Promise<void>>(async () => {});
jest.mock('./transports/tus-server-transport', () => ({
  tusServerTransport: {
    run: (...args: unknown[]) => mockTusRun(args[0] as Record<string, unknown>),
    cancel: (...args: unknown[]) => mockTusCancel(args[0] as string, args[1] as string | null),
  },
}));
const mockDirectRun =
  jest.fn<(params: Record<string, unknown>) => Promise<{ resourceUrl: string }>>();
jest.mock('./transports/direct-server-transport', () => ({
  directServerTransport: {
    run: (...args: unknown[]) => mockDirectRun(args[0] as Record<string, unknown>),
    cancel: jest.fn(async () => {}),
  },
}));

const mockCheckCapabilities = jest.fn<(server: string) => Promise<unknown>>();
jest.mock('./capabilities', () => ({
  checkCapabilities: (...args: [string]) => mockCheckCapabilities(...args),
  // Inline copy (not requireActual) so the mock stays free of the real module's
  // transitive imports; the manager only reads these strings.
  CAPABILITIES_REJECTION_MESSAGE: {
    unreachable: "Couldn't reach that server. Check the connection and try again.",
    'version-too-old': 'This server needs a newer version of Pulse. Update the app and try again.',
    'version-too-new': "This server hasn't been updated to work with this version of Pulse yet.",
  },
}));

const mockIsTokenExpired = jest.fn<(token: unknown, now: number) => boolean>(() => false);
jest.mock('./capability-token', () => ({
  isTokenExpired: (...args: [unknown, number]) => mockIsTokenExpired(...args),
  EXPIRY_CHECK_INTERVAL_MS: 30_000,
}));

// Import AFTER the mocks so the singleton binds to them.
// eslint-disable-next-line import/first
import { uploads } from './upload-manager';
// eslint-disable-next-line import/first
import type { UploadSession } from './types';

const mockDb = (
  jest.requireMock('@/db/drafts') as {
    __state: {
      uploadProgress: { draftId: string; patch: Record<string, unknown> }[];
      resumeUrls: string[];
      invalidationHook: ((draftId: string) => Promise<void>) | null;
    };
  }
).__state;
const mockOtherDraftPairedTo = (
  jest.requireMock('@/db/drafts') as {
    otherDraftPairedTo: jest.Mock<(artifactId: string, exclude: string) => Promise<string | null>>;
  }
).otherDraftPairedTo;

const DEST_ARTIFACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeSession(draftId: string, overrides?: Partial<UploadSession>): UploadSession {
  return {
    draftId,
    destination: {
      server: 'https://vault.example.test/pulsevault',
      token: 'tok',
      artifactId: DEST_ARTIFACT,
      resourceUrl: null,
    },
    segments: [],
    merged: { path: '/tmp/merged.mp4', durationMs: 1000 },
    consumedDestinationId: 'pool-1',
    ...overrides,
  };
}

/** Wait until the manager's live state for a draft satisfies `pred` (drain loops are async). */
async function eventually(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  mockDb.uploadProgress.length = 0;
  mockDb.resumeUrls = [];
  mockTusRun.mockReset();
  mockDirectRun.mockReset();
  mockTusCancel.mockClear();
  mockIsTokenExpired.mockReset();
  mockIsTokenExpired.mockReturnValue(false);
  mockCheckCapabilities.mockReset();
  // Default: capabilities unreachable → tus transport.
  mockCheckCapabilities.mockResolvedValue({ ok: false, reason: 'unreachable' });
});

describe('BackgroundUploadManager (characterization)', () => {
  it('registers the db invalidation hook at module load', () => {
    expect(mockDb.invalidationHook).not.toBeNull();
  });

  it('rejects an expired pairing at enqueue without touching the network', async () => {
    mockIsTokenExpired.mockReturnValue(true);
    const draftId = 'draft-expired';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => uploads.getDraftState(draftId).status === 'error');
    const state = uploads.getDraftState(draftId);
    expect(state).toMatchObject({ status: 'error', retryable: false });
    expect(mockTusRun).not.toHaveBeenCalled();
    expect(mockDb.uploadProgress).toContainEqual({
      draftId,
      patch: { status: 'failed' },
    });
  });

  it('runs a merged session to completion: manifest + video via tus, row settled, done state', async () => {
    mockTusRun.mockImplementation(async (params) => ({
      resourceUrl: `https://vault.example.test/pulsevault/upload/${(params.artifact as { artifactId: string }).artifactId}`,
    }));
    const draftId = 'draft-happy';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => uploads.getDraftState(draftId).status === 'done');

    // No captions (transcript row null) and no thumbnail (generation mocked
    // false) — the merged unit uploads the beat manifest then the video.
    expect(mockTusRun).toHaveBeenCalledTimes(2);
    const kinds = mockTusRun.mock.calls.map(
      ([params]) => (params.artifact as { kind: string }).kind,
    );
    expect(kinds).toEqual(['project', 'video']);
    // The video is the session anchor and carries the draft name + checksum.
    const video = mockTusRun.mock.calls[1][0].artifact as Record<string, unknown>;
    expect(video).toMatchObject({
      artifactId: DEST_ARTIFACT,
      name: 'My Draft',
      checksum: 'md5:deadbeef',
    });
    // Durable completion write.
    expect(
      mockDb.uploadProgress.some((w) => w.draftId === draftId && w.patch.status === 'uploaded'),
    ).toBe(true);
    // One-shot done state acknowledges back to idle.
    uploads.acknowledge(draftId);
    expect(uploads.getDraftState(draftId).status).toBe('idle');
  });

  it('selects the direct transport when the server advertises directUpload', async () => {
    mockCheckCapabilities.mockResolvedValue({
      ok: true,
      capabilities: {
        protocolVersion: 1,
        minSupportedVersion: 1,
        maxSupportedVersion: 1,
        directUpload: true,
      },
    });
    mockDirectRun.mockImplementation(async (params) => ({
      resourceUrl: `https://vault.example.test/pulsevault/artifacts/${(params.artifact as { artifactId: string }).artifactId}`,
    }));
    const draftId = 'draft-direct';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => uploads.getDraftState(draftId).status === 'done');
    expect(mockDirectRun).toHaveBeenCalled();
    expect(mockTusRun).not.toHaveBeenCalled();
    uploads.acknowledge(draftId);
  });

  it('fails terminally on an explicit protocol-version rejection instead of downgrading to TUS', async () => {
    mockCheckCapabilities.mockResolvedValue({ ok: false, reason: 'version-too-old' });
    const draftId = 'draft-version-reject';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => uploads.getDraftState(draftId).status === 'error');
    expect(uploads.getDraftState(draftId)).toMatchObject({
      status: 'error',
      retryable: false,
      reason: expect.stringContaining('newer version of Pulse'),
    });
    expect(mockTusRun).not.toHaveBeenCalled();
    expect(mockDirectRun).not.toHaveBeenCalled();
  });

  it('stays on the direct transport when offline if the draft holds a direct resume identity', async () => {
    // Default mock: capabilities unreachable. A persisted `/artifacts/…` handle
    // means a direct attempt already reserved server-side — TUS can never resume
    // it, so the run must wait out connectivity on the direct transport.
    mockDb.resumeUrls = [`https://vault.example.test/pulsevault/artifacts/${DEST_ARTIFACT}`];
    mockDirectRun.mockImplementation(async (params) => ({
      resourceUrl: `https://vault.example.test/pulsevault/artifacts/${(params.artifact as { artifactId: string }).artifactId}`,
    }));
    const draftId = 'draft-direct-sticky';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => uploads.getDraftState(draftId).status === 'done');
    expect(mockDirectRun).toHaveBeenCalled();
    expect(mockTusRun).not.toHaveBeenCalled();
    uploads.acknowledge(draftId);
  });

  it('stays on TUS when a TUS resume identity exists, even after the server starts advertising directUpload', async () => {
    // Profiles share the artifactId space: a direct grant for an id holding a
    // live TUS reservation is a hard 409 (never same-shape re-grantable), so a
    // capability UPGRADE mid-draft must not move a run off its TUS resume state.
    mockCheckCapabilities.mockResolvedValue({
      ok: true,
      capabilities: {
        protocolVersion: 1,
        minSupportedVersion: 1,
        maxSupportedVersion: 1,
        directUpload: true,
      },
    });
    mockDb.resumeUrls = ['https://vault.example.test/pulsevault/upload/aWQtdGVzdA'];
    mockTusRun.mockImplementation(async () => ({
      resourceUrl: 'https://vault.example.test/pulsevault/upload/aWQtdGVzdA',
    }));
    const draftId = 'draft-tus-pinned';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => uploads.getDraftState(draftId).status === 'done');
    expect(mockTusRun).toHaveBeenCalled();
    expect(mockDirectRun).not.toHaveBeenCalled();
    uploads.acknowledge(draftId);
  });

  it('drops a direct-profile handle rather than feeding it to TUS as a resume URL', async () => {
    // Server reachable but direct upload disabled (capability rollback): the
    // persisted `/artifacts/…` handle is meaningless to TUS — it must arrive
    // at the transport as null (fresh create), not as a resume identity.
    mockCheckCapabilities.mockResolvedValue({
      ok: true,
      capabilities: {
        protocolVersion: 1,
        minSupportedVersion: 1,
        maxSupportedVersion: 1,
        directUpload: false,
      },
    });
    mockTusRun.mockImplementation(async () => ({
      resourceUrl: 'https://vault.example.test/pulsevault/upload/x',
    }));
    const draftId = 'draft-cross-profile';
    const session = makeSession(draftId);
    session.destination.resourceUrl = `https://vault.example.test/pulsevault/artifacts/${DEST_ARTIFACT}`;
    uploads.enqueue(session);
    await eventually(() => uploads.getDraftState(draftId).status === 'done');
    const video = mockTusRun.mock.calls
      .map(([params]) => params.artifact as { kind: string; resourceUrl: string | null })
      .find((artifact) => artifact.kind === 'video');
    expect(video).toBeDefined();
    expect(video!.resourceUrl).toBeNull();
    uploads.acknowledge(draftId);
  });

  it('guards against two live sessions claiming the same destination artifactId', async () => {
    // Gate every transport call until released — then let ALL calls (manifest
    // AND video) flow, so the singleton drain can finish draft-a and never
    // blocks the suite's later tests.
    let blocked = true;
    const waiters: (() => void)[] = [];
    mockTusRun.mockImplementation(async () => {
      if (blocked) await new Promise<void>((resolve) => waiters.push(resolve));
      return { resourceUrl: 'https://vault.example.test/pulsevault/upload/x' };
    });
    const releaseFirst = () => {
      blocked = false;
      waiters.splice(0).forEach((resolve) => resolve());
    };
    const first = 'draft-a';
    const second = 'draft-b';
    uploads.enqueue(makeSession(first));
    await eventually(() => uploads.getDraftState(first).status === 'uploading');

    uploads.enqueue(makeSession(second));
    await eventually(() => uploads.getDraftState(second).status === 'error');
    expect(uploads.getDraftState(second)).toMatchObject({
      status: 'error',
      retryable: false,
    });

    releaseFirst();
    await eventually(() => uploads.getDraftState(first).status === 'done');
    uploads.acknowledge(first);
  });

  it('refuses a run whose artifactId is durably paired to another draft (post-restart shape)', async () => {
    // The in-memory map can't see a rival that failed before a restart — the
    // durable check in runSession must catch it from the drafts table instead.
    // Keyed on the artifactId (not a once-queue) so the singleton drain's
    // ordering across tests can't consume it early.
    const rivalArtifact = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    mockOtherDraftPairedTo.mockImplementation(async (artifactId) =>
      artifactId === rivalArtifact ? 'some-other-draft' : null,
    );
    try {
      const draftId = 'draft-durable-rival';
      const session = makeSession(draftId);
      session.destination.artifactId = rivalArtifact;
      uploads.enqueue(session);
      await eventually(() => uploads.getDraftState(draftId).status === 'error');
      expect(uploads.getDraftState(draftId)).toMatchObject({
        status: 'error',
        retryable: false,
      });
    } finally {
      mockOtherDraftPairedTo.mockImplementation(async () => null);
    }
  });

  it('cancel aborts the in-flight transfer, resets state, and server-cancels the live resource', async () => {
    let sawAbort = false;
    mockTusRun.mockImplementation(async (params) => {
      const signal = params.signal as AbortSignal;
      const onResourceCreated = params.onResourceCreated as (url: string) => Promise<void>;
      await onResourceCreated('https://vault.example.test/pulsevault/upload/live');
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        });
      });
      return { resourceUrl: 'never' };
    });
    const draftId = 'draft-cancel';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => mockTusRun.mock.calls.length === 1);

    await uploads.cancel(draftId);
    expect(sawAbort).toBe(true);
    expect(uploads.getDraftState(draftId).status).toBe('idle');
    // Durable reset happened before/with the server-side cancel.
    expect(
      mockDb.uploadProgress.some((w) => w.draftId === draftId && w.patch.status === 'idle'),
    ).toBe(true);
    await eventually(() => mockTusCancel.mock.calls.length === 1);
    expect(mockTusCancel.mock.calls[0][0]).toBe(
      'https://vault.example.test/pulsevault/upload/live',
    );
  });

  it('invalidateForMutation aborts the run and fire-and-forget cancels every persisted resume URL', async () => {
    mockDb.resumeUrls = [
      'https://vault.example.test/pulsevault/upload/persisted-1',
      'https://vault.example.test/pulsevault/upload/persisted-2',
    ];
    mockTusRun.mockImplementation(async (params) => {
      const signal = params.signal as AbortSignal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      });
      return { resourceUrl: 'never' };
    });
    const draftId = 'draft-invalidate';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => mockTusRun.mock.calls.length === 1);

    await uploads.invalidateForMutation(draftId);
    expect(uploads.getDraftState(draftId).status).toBe('idle');
    await eventually(() => mockTusCancel.mock.calls.length >= 2);
    const cancelled = mockTusCancel.mock.calls.map((c) => c[0]);
    expect(cancelled).toEqual(expect.arrayContaining(mockDb.resumeUrls));
  });
});
