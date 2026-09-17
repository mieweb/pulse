/**
 * Characterization tests for the BackgroundUploadManager singleton under the
 * single-shot model. Everything effectful (DB, secure store, native files,
 * transports, notifications, the Android foreground service) is mocked at the
 * module boundary; the tests pin the ORCHESTRATION: queueing, token gating,
 * pairing-time transport selection, completion persistence, failure-as-event
 * (burn + toast), cancellation, and the launch sweep. The wire behavior under
 * these transports is covered by tus-client/direct-client unit tests and the
 * pv-integration suite.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// ---- module-boundary mocks (hoisted by jest above the imports below) ----

// Shared state lives INSIDE the factory (exposed as `__state`) because jest
// hoists these factories above any test-file const (TDZ).
jest.mock('@/db/drafts', () => {
  // Deliberately untyped: babel-plugin-jest-hoist walks TS annotations inside
  // factories and rejects any identifier they contain. The importing side
  // re-types this via the `__state` cast below the imports.
  const state = {
    uploadProgress: [] as unknown[],
    burned: [] as unknown[],
    interrupted: [] as unknown[],
    draftStatus: null as unknown,
  };
  return {
    __state: state,
    burnUploadPairing: jest.fn(async (id) => {
      state.burned.push(id);
    }),
    getDraftName: jest.fn(async () => 'My Draft'),
    getDraftUploadStatus: jest.fn(async () => state.draftStatus),
    getInterruptedUploads: jest.fn(async () => state.interrupted),
    setUploadProgress: jest.fn(async (id, patch) => {
      state.uploadProgress.push({ draftId: id, patch });
    }),
  };
});

jest.mock('@/db/secure-token', () => ({ getDraftToken: jest.fn(async () => 'tok') }));
jest.mock('@/db/transcripts', () => ({ getDraftTranscriptRow: jest.fn(async () => null) }));
jest.mock('@/features/transcription/vtt', () => ({ linesToVtt: jest.fn(() => '') }));
jest.mock('@/features/transcription/whisper', () => ({ parseTranscriptLines: jest.fn(() => []) }));
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
const mockNotifyFailed = jest.fn(async () => {});
jest.mock('./notify', () => ({
  uploadNotify: {
    ensurePermission: jest.fn(async () => {}),
    complete: jest.fn(async () => {}),
    failed: (...args: unknown[]) => mockNotifyFailed(...(args as [])),
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
      burned: string[];
      interrupted: Record<string, unknown>[];
      draftStatus: string | null;
    };
  }
).__state;

const SERVER = 'https://vault.example.test/pulsevault';
const DEST_ARTIFACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeSession(draftId: string, overrides?: Partial<UploadSession>): UploadSession {
  return {
    draftId,
    destination: {
      server: SERVER,
      token: 'tok',
      artifactId: DEST_ARTIFACT,
      directUpload: false,
    },
    segments: [],
    merged: { path: '/tmp/merged.mp4', durationMs: 1000 },
    ...overrides,
  };
}

/** Wait until `pred` holds (drain loops are async). */
async function eventually(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const mockToast = jest.fn<(message: string) => void>();
uploads.registerToast((m) => mockToast(m));

beforeEach(() => {
  mockDb.uploadProgress.length = 0;
  mockDb.burned.length = 0;
  mockDb.interrupted.length = 0;
  mockDb.draftStatus = null;
  mockToast.mockClear();
  mockNotifyFailed.mockClear();
  mockTusRun.mockReset();
  mockDirectRun.mockReset();
  mockTusCancel.mockClear();
  mockIsTokenExpired.mockReset();
  mockIsTokenExpired.mockReturnValue(false);
});

describe('BackgroundUploadManager (single-shot model)', () => {
  it('uploads via TUS and settles: durable artifacts URL, tokened watch link on done', async () => {
    mockTusRun.mockImplementation(async () => ({ resourceUrl: `${SERVER}/upload/x` }));
    const draftId = 'draft-happy';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => uploads.getDraftState(draftId).status === 'done');

    const done = uploads.getDraftState(draftId);
    // The one-shot done state carries the tokened watch link…
    expect(done).toMatchObject({
      status: 'done',
      resourceUrl: `${SERVER}/artifacts/${DEST_ARTIFACT}?token=tok`,
    });
    // …while the durable row keeps the plain serving URL (tokens never hit the DB).
    expect(
      mockDb.uploadProgress.some(
        (w) =>
          w.draftId === draftId &&
          w.patch.status === 'uploaded' &&
          w.patch.resourceUrl === `${SERVER}/artifacts/${DEST_ARTIFACT}`,
      ),
    ).toBe(true);
    expect(mockDb.burned).toHaveLength(0);
    uploads.acknowledge(draftId);
    expect(uploads.getDraftState(draftId).status).toBe('idle');
  });

  it('uses the direct transport when the PAIRING advertised it — no capability probe', async () => {
    mockDirectRun.mockImplementation(async () => ({
      resourceUrl: `${SERVER}/artifacts/${DEST_ARTIFACT}`,
    }));
    const draftId = 'draft-direct';
    uploads.enqueue(
      makeSession(draftId, {
        destination: { server: SERVER, token: 'tok', artifactId: DEST_ARTIFACT, directUpload: true },
      }),
    );
    await eventually(() => uploads.getDraftState(draftId).status === 'done');
    expect(mockDirectRun).toHaveBeenCalled();
    expect(mockTusRun).not.toHaveBeenCalled();
    uploads.acknowledge(draftId);
  });

  it('treats a terminal failure as an EVENT: burns the pairing, toasts, notifies, returns to idle', async () => {
    mockTusRun.mockImplementation(async (params) => {
      const artifact = params.artifact as { kind: string };
      if (artifact.kind === 'video') {
        throw Object.assign(new Error('already has an upload'), { retryable: false });
      }
      return { resourceUrl: `${SERVER}/upload/x` };
    });
    const draftId = 'draft-fail';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => mockDb.burned.includes(draftId));

    // No failed status, no error live state — the draft is simply idle again.
    expect(uploads.getDraftState(draftId).status).toBe('idle');
    expect(mockDb.uploadProgress.some((w) => w.patch.status === 'failed')).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('scan a new link'));
    expect(mockNotifyFailed).toHaveBeenCalled();
    // A burned pairing means a fresh enqueue for the same draft is possible.
    mockTusRun.mockImplementation(async () => ({ resourceUrl: `${SERVER}/upload/y` }));
    uploads.enqueue(makeSession(draftId));
    await eventually(() => uploads.getDraftState(draftId).status === 'done');
    uploads.acknowledge(draftId);
  });

  it('rejects an expired pairing at enqueue as the same failure event (no run starts)', async () => {
    mockIsTokenExpired.mockReturnValue(true);
    const draftId = 'draft-expired';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => mockDb.burned.includes(draftId));
    expect(mockTusRun).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('expired'));
    expect(uploads.getDraftState(draftId).status).toBe('idle');
  });

  it('cancel aborts the run, burns the pairing, and server-DELETEs the in-flight handle', async () => {
    mockTusRun.mockImplementation(async (params) => {
      const onResourceCreated = params.onResourceCreated as (url: string) => Promise<void>;
      await onResourceCreated(`${SERVER}/upload/inflight`);
      const signal = params.signal as AbortSignal;
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      });
      return { resourceUrl: `${SERVER}/upload/inflight` };
    });
    const draftId = 'draft-cancel';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => mockTusRun.mock.calls.length > 0);

    await uploads.cancel(draftId);
    expect(mockDb.burned).toContain(draftId);
    expect(uploads.getDraftState(draftId).status).toBe('idle');
    await eventually(() => mockTusCancel.mock.calls.length > 0);
    expect(mockTusCancel).toHaveBeenCalledWith(`${SERVER}/upload/inflight`, 'tok');
    // No failure event for a deliberate cancel.
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockNotifyFailed).not.toHaveBeenCalled();
  });

  it('ignores a duplicate enqueue while a run is live', async () => {
    let release: () => void = () => {};
    mockTusRun.mockImplementation(async (params) => {
      const artifact = params.artifact as { kind: string };
      // Related artifacts flow; only the video (last) is gated open.
      if (artifact.kind !== 'video') return { resourceUrl: `${SERVER}/upload/rel` };
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { resourceUrl: `${SERVER}/upload/x` };
    });
    const draftId = 'draft-dup';
    uploads.enqueue(makeSession(draftId));
    await eventually(
      () => mockTusRun.mock.calls.filter(([p]) => (p.artifact as { kind: string }).kind === 'video').length > 0,
    );
    uploads.enqueue(makeSession(draftId));
    // Second enqueue neither restarted the run nor re-wrote 'uploading'.
    const uploadingWrites = mockDb.uploadProgress.filter((w) => w.patch.status === 'uploading');
    expect(uploadingWrites).toHaveLength(1);
    release();
    await eventually(() => uploads.getDraftState(draftId).status === 'done');
    uploads.acknowledge(draftId);
  });

  describe('launch sweep', () => {
    it('marks an interrupted upload uploaded when its artifact already serves', async () => {
      mockDb.interrupted.push({
        id: 'draft-sweep-done',
        uploadServer: SERVER,
        uploadArtifactId: DEST_ARTIFACT,
      });
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 206 }) as never);
      try {
        await uploads.sweepInterruptedUploads();
        expect(
          mockDb.uploadProgress.some(
            (w) =>
              w.draftId === 'draft-sweep-done' &&
              w.patch.status === 'uploaded' &&
              w.patch.resourceUrl === `${SERVER}/artifacts/${DEST_ARTIFACT}`,
          ),
        ).toBe(true);
        expect(mockDb.burned).not.toContain('draft-sweep-done');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('burns an interrupted upload whose artifact does not serve, with a toast', async () => {
      mockDb.interrupted.push({
        id: 'draft-sweep-burn',
        uploadServer: SERVER,
        uploadArtifactId: DEST_ARTIFACT,
      });
      const fetchSpy = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 404 }) as never);
      try {
        await uploads.sweepInterruptedUploads();
        expect(mockDb.burned).toContain('draft-sweep-burn');
        expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('scan a new link'));
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
