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
    // The draft row's upload_status. Absent = 'uploading' (the claim wrote it before
    // enqueue); burn sets NULL; the CAS settle needs 'uploading' and sets 'uploaded'.
    rows: new Map(),
    uploaded: [] as unknown[],
    burned: [] as unknown[],
    interrupted: [] as unknown[],
  };
  const status = (id: unknown) => (state.rows.has(id) ? state.rows.get(id) : 'uploading');
  return {
    __state: state,
    burnUploadPairing: jest.fn(async (id) => {
      if (status(id) === 'uploaded') return false;
      state.rows.set(id, null);
      state.burned.push(id);
      return true;
    }),
    markUploaded: jest.fn(async (draftId, artifactId) => {
      if (status(draftId) !== 'uploading') return false;
      state.rows.set(draftId, 'uploaded');
      state.uploaded.push({ draftId, artifactId });
      return true;
    }),
    getDraftName: jest.fn(async () => 'My Draft'),
    getInterruptedUploads: jest.fn(async () => state.interrupted),
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
jest.mock('./tus-client', () => ({
  ...(jest.requireActual('./tus-client') as object),
  cancelTusUpload: (...args: unknown[]) =>
    mockTusCancel(args[0] as string, args[1] as string | null),
}));
jest.mock('./transports/tus-server-transport', () => ({
  tusServerTransport: {
    run: (...args: unknown[]) => mockTusRun(args[0] as Record<string, unknown>),
  },
}));
const mockDirectRun =
  jest.fn<(params: Record<string, unknown>) => Promise<{ resourceUrl: string }>>();
jest.mock('./transports/direct-server-transport', () => ({
  directServerTransport: {
    run: (...args: unknown[]) => mockDirectRun(args[0] as Record<string, unknown>),
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
      rows: Map<string, 'uploading' | 'uploaded' | null>;
      uploaded: { draftId: string; artifactId: string }[];
      burned: string[];
      interrupted: Record<string, unknown>[];
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

/** A draft row left 'uploading' by an app kill — what the launch sweep settles. */
function interruptedRow(id: string) {
  return { id, uploadServer: SERVER, uploadArtifactId: DEST_ARTIFACT };
}

beforeEach(() => {
  mockDb.rows.clear();
  mockDb.uploaded.length = 0;
  mockDb.burned.length = 0;
  mockDb.interrupted.length = 0;
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
    // …while the durable row is settled by a compare-and-set on exactly this pairing.
    expect(mockDb.uploaded).toEqual([{ draftId, artifactId: DEST_ARTIFACT }]);
    expect(mockDb.burned).toHaveLength(0);
    // Nothing to discard: a finished run keeps every artifact it created.
    expect(mockTusCancel).not.toHaveBeenCalled();
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
        destination: {
          server: SERVER,
          token: 'tok',
          artifactId: DEST_ARTIFACT,
          directUpload: true,
        },
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
      const onResourceCreated = params.onResourceCreated as (url: string) => Promise<void>;
      await onResourceCreated(`${SERVER}/upload/${artifact.kind}`);
      return { resourceUrl: `${SERVER}/upload/${artifact.kind}` };
    });
    const draftId = 'draft-fail';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => mockDb.burned.includes(draftId));

    // No failed status, no error live state — the draft is simply idle again.
    expect(uploads.getDraftState(draftId).status).toBe('idle');
    expect(mockDb.uploaded).toHaveLength(0);
    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('scan a new link'));
    expect(mockNotifyFailed).toHaveBeenCalled();
    // The manifest that landed before the video failed is orphaned server-side — DELETE it.
    await eventually(() => mockTusCancel.mock.calls.length > 0);
    expect(mockTusCancel).toHaveBeenCalledWith(`${SERVER}/upload/project`, 'tok');
    // A burned pairing means a fresh claim (which writes 'uploading' again) can enqueue the same draft.
    mockDb.rows.set(draftId, 'uploading');
    mockTusRun.mockImplementation(async () => ({ resourceUrl: `${SERVER}/upload/y` }));
    uploads.enqueue(makeSession(draftId));
    await eventually(() => uploads.getDraftState(draftId).status === 'done');
    uploads.acknowledge(draftId);
  });

  it('rejects an expired pairing at enqueue as the same failure event (no run starts)', async () => {
    mockIsTokenExpired.mockReturnValue(true);
    const draftId = 'draft-expired';
    uploads.enqueue(makeSession(draftId));
    await eventually(() => mockToast.mock.calls.length > 0);
    expect(mockTusRun).not.toHaveBeenCalled();
    expect(mockDb.burned).toContain(draftId);
    expect(mockToast).toHaveBeenCalledWith('Upload link expired — scan a new link to try again.');
    expect(uploads.getDraftState(draftId).status).toBe('idle');
  });

  it('cancel aborts the run, burns the pairing, and server-DELETEs everything the run created', async () => {
    mockTusRun.mockImplementation(async (params) => {
      const artifact = params.artifact as { kind: string };
      const onResourceCreated = params.onResourceCreated as (url: string) => Promise<void>;
      await onResourceCreated(`${SERVER}/upload/${artifact.kind}`);
      if (artifact.kind !== 'video') return { resourceUrl: `${SERVER}/upload/${artifact.kind}` };
      const signal = params.signal as AbortSignal;
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      });
      return { resourceUrl: `${SERVER}/upload/video` };
    });
    const draftId = 'draft-cancel';
    uploads.enqueue(makeSession(draftId));
    await eventually(
      () =>
        mockTusRun.mock.calls.filter(([p]) => (p.artifact as { kind: string }).kind === 'video')
          .length > 0,
    );

    await uploads.cancel(draftId);
    expect(mockDb.burned).toContain(draftId);
    expect(uploads.getDraftState(draftId).status).toBe('idle');
    // The finished manifest AND the in-flight video: the anchor will never complete.
    await eventually(() => mockTusCancel.mock.calls.length >= 2);
    expect(mockTusCancel.mock.calls.map(([url]) => url).sort()).toEqual([
      `${SERVER}/upload/project`,
      `${SERVER}/upload/video`,
    ]);
    expect(mockTusCancel).toHaveBeenCalledWith(`${SERVER}/upload/video`, 'tok');
    // No failure event for a deliberate cancel.
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockNotifyFailed).not.toHaveBeenCalled();
  });

  it('a lost CAS (row burned during the final PATCH) resets to idle and discards what the run created', async () => {
    const draftId = 'draft-cas-lost';
    mockTusRun.mockImplementation(async (params) => {
      const artifact = params.artifact as { kind: string };
      const onResourceCreated = params.onResourceCreated as (url: string) => Promise<void>;
      await onResourceCreated(`${SERVER}/upload/${artifact.kind}`);
      if (artifact.kind === 'video') {
        // The burn lands mid-transfer (a cancel that raced the last chunk); the transfer's
        // final progress tick then repopulates the live state AFTER cancel's own reset.
        mockDb.rows.set(draftId, null);
        const onProgress = params.onProgress as (p: {
          bytesSent: number;
          totalBytes: number;
        }) => void;
        onProgress({ bytesSent: 1024, totalBytes: 1024 });
      }
      return { resourceUrl: `${SERVER}/upload/${artifact.kind}` };
    });
    uploads.enqueue(makeSession(draftId));
    await eventually(() => mockTusCancel.mock.calls.length >= 2);

    expect(mockDb.uploaded).toHaveLength(0);
    // Not stuck at 100%: the CAS loser resets the ring like cancel does…
    expect(uploads.getDraftState(draftId).status).toBe('idle');
    // …and DELETEs every artifact the run created — debris under a burned pairing.
    expect(mockTusCancel.mock.calls.map(([url]) => url).sort()).toEqual([
      `${SERVER}/upload/project`,
      `${SERVER}/upload/video`,
    ]);
    // Not a failure event of its own — whoever burned the row already told the user.
    expect(mockToast).not.toHaveBeenCalled();
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
      () =>
        mockTusRun.mock.calls.filter(([p]) => (p.artifact as { kind: string }).kind === 'video')
          .length > 0,
    );
    uploads.enqueue(makeSession(draftId));
    // Second enqueue didn't restart the run: the video PATCH is still the gated
    // first one, and no extra durable write appeared (the 'uploading' marker is
    // the claim's job, before enqueue — the manager itself writes none).
    const videoRuns = mockTusRun.mock.calls.filter(
      ([p]) => (p.artifact as { kind: string }).kind === 'video',
    );
    expect(videoRuns).toHaveLength(1);
    expect(mockDb.uploaded).toHaveLength(0);
    release();
    await eventually(() => uploads.getDraftState(draftId).status === 'done');
    uploads.acknowledge(draftId);
  });

  describe('launch sweep', () => {
    /** Run one sweep against a probe that answers `response` (or throws it); returns the probe calls. */
    async function sweepWith(response: Response | Error): Promise<unknown[][]> {
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      if (response instanceof Error) fetchSpy.mockRejectedValue(response as never);
      else fetchSpy.mockResolvedValue(response as never);
      try {
        await uploads.sweepInterruptedUploads();
        return fetchSpy.mock.calls;
      } finally {
        fetchSpy.mockRestore();
      }
    }

    it('marks an interrupted upload uploaded (CAS on its pairing) when its artifact already serves', async () => {
      mockDb.interrupted.push(interruptedRow('draft-sweep-done'));
      const calls = await sweepWith(new Response(null, { status: 206 }));
      // One probe: a one-byte ranged GET of the artifacts URL, bearer-authed, redirects unfollowed.
      expect(calls).toEqual([
        [
          `${SERVER}/artifacts/${DEST_ARTIFACT}`,
          { redirect: 'manual', headers: { Range: 'bytes=0-0', Authorization: 'Bearer tok' } },
        ],
      ]);
      expect(mockDb.uploaded).toEqual([{ draftId: 'draft-sweep-done', artifactId: DEST_ARTIFACT }]);
      expect(mockDb.burned).not.toContain('draft-sweep-done');
      expect(mockToast).not.toHaveBeenCalled();
    });

    it("treats a storage adapter's presigned redirect as serving", async () => {
      mockDb.interrupted.push(interruptedRow('draft-sweep-redirect'));
      await sweepWith(new Response(null, { status: 302 }));
      expect(mockDb.uploaded).toEqual([
        { draftId: 'draft-sweep-redirect', artifactId: DEST_ARTIFACT },
      ]);
    });

    it('leaves the row for the next sweep when the probe cannot reach the server (offline)', async () => {
      mockDb.interrupted.push(interruptedRow('draft-sweep-offline'));
      await sweepWith(new TypeError('Network request failed'));
      expect(mockDb.burned).not.toContain('draft-sweep-offline');
      expect(mockDb.uploaded).toHaveLength(0);
      expect(mockToast).not.toHaveBeenCalled();
    });

    it.each([404, 403, 500])(
      'burns an interrupted upload on any other answer (HTTP %i), with a toast',
      async (status) => {
        mockDb.interrupted.push(interruptedRow('draft-sweep-burn'));
        await sweepWith(new Response(null, { status }));
        expect(mockDb.burned).toContain('draft-sweep-burn');
        expect(mockDb.uploaded).toHaveLength(0);
        expect(mockToast).toHaveBeenCalledWith(
          'An upload didn’t finish — scan a new link to try again.',
        );
      },
    );
  });
});
