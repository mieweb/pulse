/**
 * Orchestration tests for the upload manager. Everything effectful (DB, secure store, native
 * files, the TUS client, notifications, the Android foreground service) is mocked at the module
 * boundary; the wire behaviour under `uploadViaTus` is covered by tus-client.test.ts and the
 * pv-integration suite. These pin the model: one link, one upload; a failure or cancel unpairs
 * the draft and DELETEs what the run created; the database decides a cancel/finish race; a kill
 * fails the draft at the next launch.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// ---- module-boundary mocks (hoisted by jest above the imports below) ----

// Shared state lives INSIDE the factories (exposed as `__state`) because jest hoists these
// factories above any test-file const (TDZ), so their types use only built-ins.
jest.mock('@/db/drafts', () => {
  const state = {
    // draftId → upload_status ('uploading' | 'uploaded' | null) and the paired artifactId.
    status: new Map<string, string | null>(),
    artifact: new Map<string, string>(),
    // Every write in order, e.g. 'pair:d1', 'burn:d1', 'uploaded:d1'.
    log: [] as string[],
  };
  return {
    __state: state,
    setUploadDestination: jest.fn(async (draftId: string, destination: { artifactId: string }) => {
      state.status.set(draftId, 'uploading');
      state.artifact.set(draftId, destination.artifactId);
      state.log.push(`pair:${draftId}`);
    }),
    markUploaded: jest.fn(async (draftId: string, artifactId: string) => {
      if (state.status.get(draftId) !== 'uploading') return false;
      if (state.artifact.get(draftId) !== artifactId) return false;
      state.status.set(draftId, 'uploaded');
      state.log.push(`uploaded:${draftId}`);
      return true;
    }),
    burnUploadPairing: jest.fn(async (draftId: string, artifactId?: string) => {
      if (state.status.get(draftId) !== 'uploading') return false;
      if (artifactId !== undefined && state.artifact.get(draftId) !== artifactId) return false;
      state.status.set(draftId, null);
      state.artifact.delete(draftId);
      state.log.push(`burn:${draftId}`);
      return true;
    }),
    getUploadingDraftIds: jest.fn(async () =>
      [...state.status].filter(([, s]) => s === 'uploading').map(([id]) => id),
    ),
    getUploadedDraftIds: jest.fn(async () =>
      [...state.status].filter(([, s]) => s === 'uploaded').map(([id]) => id),
    ),
    getDraftName: jest.fn(async () => 'My Draft'),
  };
});

jest.mock('@/db/destinations', () => {
  const state = { pool: new Set<string>(), log: [] as string[] };
  return {
    __state: state,
    deleteDestination: jest.fn(async (id: string) => {
      state.log.push(`pool-delete:${id}`);
      return state.pool.delete(id);
    }),
  };
});

jest.mock('@/db/secure-token', () => {
  const state = {
    links: new Map<string, { url: string; expiresAt: number }>(),
    deleted: [] as string[],
  };
  return {
    __state: state,
    getViewLink: jest.fn(async (id: string) => state.links.get(id) ?? null),
    setViewLink: jest.fn(async (id: string, link: { url: string; expiresAt: number }) => {
      state.links.set(id, link);
    }),
    deleteViewLink: jest.fn(async (id: string) => {
      state.links.delete(id);
      state.deleted.push(id);
    }),
  };
});
jest.mock('@/db/transcripts', () => ({
  getDraftTranscriptRow: jest.fn(async () => ({ lines: '[{"text":"hi"}]', editedLines: null })),
}));
jest.mock('@/features/transcription/vtt', () => ({ linesToVtt: jest.fn(() => 'WEBVTT') }));
jest.mock('@/features/transcription/whisper', () => ({
  parseTranscriptLines: jest.fn(() => [{ text: 'hi' }]),
}));
jest.mock('@/utils/video', () => ({
  generateThumbnailFile: jest.fn(async (_video: string, out: string) => {
    (
      jest.requireMock('expo-file-system') as { __state: { present: Set<string> } }
    ).__state.present.add(out);
    return true;
  }),
}));
jest.mock('@/utils/file-store', () => ({
  absolutize: (p: string) => `/abs/${p}`,
  toFileUri: (p: string) => (p.startsWith('file://') ? p : `file://${p}`),
}));

jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `related-${++n}` };
});

jest.mock('expo-file-system', () => {
  // A file opened by path (the draft's export) exists; one made in a directory (a temp file)
  // exists once written.
  const state = {
    present: new Set<string>(),
    deletedFiles: [] as string[],
    deletedDirs: [] as string[],
  };
  class MockFile {
    uri: string;
    name: string;
    size = 1024;
    constructor(...parts: unknown[]) {
      this.uri = String(parts[parts.length - 1]);
      this.name = this.uri.split('/').pop() ?? 'mock';
      if (parts.length === 1) state.present.add(this.uri);
    }
    get exists() {
      return state.present.has(this.uri);
    }
    write() {
      state.present.add(this.uri);
    }
    delete() {
      state.present.delete(this.uri);
      state.deletedFiles.push(this.name);
    }
  }
  class MockDirectory {
    name: string;
    exists = true;
    constructor(...parts: unknown[]) {
      this.name = String(parts[parts.length - 1]);
    }
    create() {}
    delete() {
      state.deletedDirs.push(this.name);
    }
  }
  return { __state: state, Directory: MockDirectory, File: MockFile, Paths: { cache: '/cache' } };
});
jest.mock('expo-file-system/legacy', () => ({
  getInfoAsync: jest.fn(async () => ({ exists: true, md5: 'deadbeef' })),
}));

jest.mock('./native-chunk-upload', () => {
  const state = { log: [] as string[], cancelOrphans: async (): Promise<number> => 0 };
  return {
    __state: state,
    cancelOrphanedUploadTasks: jest.fn(async () => {
      state.log.push('cancel-orphans');
      return state.cancelOrphans();
    }),
    cleanupStaleUploadTempFiles: jest.fn(() => {
      state.log.push('cleanup-chunks');
    }),
    uploadChunkNative: jest.fn(),
  };
});

jest.mock('./keep-alive', () => ({
  keepAlive: { begin: jest.fn(async () => {}), end: jest.fn(async () => {}), note: jest.fn() },
}));
const mockNotifyFailed = jest.fn(async () => {});
jest.mock('./notify', () => ({
  uploadNotify: {
    ensurePermission: jest.fn(async () => {}),
    complete: jest.fn(async () => {}),
    failed: () => mockNotifyFailed(),
  },
}));

jest.mock('./capabilities', () => ({
  ...(jest.requireActual('./capabilities') as object),
  checkCapabilities: jest.fn(async () => ({ ok: true, capabilities: {} })),
}));

type TusCall = {
  artifactId: string;
  filename: string;
  kind: string;
  relatedTo?: string;
  checksum?: string;
  name?: string;
  token: string | null;
  signal: AbortSignal;
  onResourceCreated?: (url: string) => void;
  onProgress?: (p: { bytesSent: number; totalBytes: number }) => void;
};
const mockUploadViaTus = jest.fn<(opts: TusCall) => Promise<{ resourceUrl: string }>>();
const mockCancelTus = jest.fn<(url: string, token: string | null) => Promise<void>>(async () => {});
jest.mock('./tus-client', () => ({
  ...(jest.requireActual('./tus-client') as object),
  uploadViaTus: (opts: unknown) => mockUploadViaTus(opts as TusCall),
  cancelTusUpload: (url: unknown, token: unknown) =>
    mockCancelTus(url as string, token as string | null),
}));

const mockIsTokenExpired = jest.fn<(token: unknown, now: number) => boolean>(() => false);
const mockRequestViewLink = jest.fn<
  (opts: {
    server: string;
    artifactId: string;
    token: string | null;
  }) => Promise<{ url: string; expiresAt: number } | null>
>(async () => null);
jest.mock('./view-link', () => ({
  requestViewLink: (opts: unknown) =>
    mockRequestViewLink(opts as { server: string; artifactId: string; token: string | null }),
}));

jest.mock('./capability-token', () => ({
  // The tests' tokens are opaque: no known expiry.
  expiresAtMs: () => null,
  isTokenExpired: (token: unknown, now: number) => mockIsTokenExpired(token, now),
}));

// Import AFTER the mocks so the singleton binds to them.
// eslint-disable-next-line import/first
import { deleteDestination } from '@/db/destinations';
// eslint-disable-next-line import/first
import { burnUploadPairing, getDraftName, setUploadDestination } from '@/db/drafts';
// eslint-disable-next-line import/first
import { keepAlive } from './keep-alive';
// eslint-disable-next-line import/first
import { checkCapabilities } from './capabilities';
// eslint-disable-next-line import/first
import { TusUploadError } from './tus-client';
// eslint-disable-next-line import/first
import { uploads } from './upload-manager';

type Status = 'uploading' | 'uploaded' | null;
const db = (
  jest.requireMock('@/db/drafts') as {
    __state: {
      status: Map<string, Status>;
      artifact: Map<string, string>;
      log: string[];
    };
  }
).__state;
const secure = (
  jest.requireMock('@/db/secure-token') as {
    __state: { links: Map<string, { url: string; expiresAt: number }>; deleted: string[] };
  }
).__state;
const pool = (
  jest.requireMock('@/db/destinations') as { __state: { pool: Set<string>; log: string[] } }
).__state;
const files = (
  jest.requireMock('expo-file-system') as {
    __state: { deletedFiles: string[]; deletedDirs: string[] };
  }
).__state;
const native = (
  jest.requireMock('./native-chunk-upload') as {
    __state: { log: string[]; cancelOrphans: () => Promise<number> };
  }
).__state;

const SERVER = 'https://vault.example.test/pulsevault';

const mockToast = jest.fn<(message: string) => void>();
uploads.registerToast((m) => mockToast(m));

/** Claim pool destination `destId` (artifact `art-<destId>`) for `draftId`. */
function claim(draftId: string, destId = `dest-${draftId}`) {
  pool.pool.add(destId);
  return uploads.claim({
    draftId,
    destinationId: destId,
    destination: { server: SERVER, token: 'tok', artifactId: `art-${destId}` },
    segments: [],
    merged: { path: `/drafts/${draftId}/export.mp4`, durationMs: 1000 },
  });
}

/** Every upload the fake server "creates" reports `<server>/upload/<artifactId>`. */
function created(opts: TusCall): string {
  const url = `${SERVER}/upload/${opts.artifactId}`;
  opts.onResourceCreated?.(url);
  return url;
}

/** An `uploadViaTus` that creates the upload, then runs `video` for the video only. */
function tusWith(video: (opts: TusCall, url: string) => Promise<void> | void = () => {}) {
  mockUploadViaTus.mockImplementation(async (opts) => {
    const url = created(opts);
    if (opts.kind === 'video') await video(opts, url);
    return { resourceUrl: url };
  });
}

/** An `uploadViaTus` whose video waits until aborted. */
function videoHangsUntilAborted() {
  tusWith(
    (opts) =>
      new Promise<void>((_, reject) => {
        opts.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      }),
  );
}

const videoCalls = () => mockUploadViaTus.mock.calls.filter(([o]) => o.kind === 'video');

/** Wait until `pred` holds (drain loops are async). */
async function eventually(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  db.status.clear();
  db.artifact.clear();
  db.log.length = 0;
  pool.pool.clear();
  pool.log.length = 0;
  files.deletedFiles.length = 0;
  files.deletedDirs.length = 0;
  native.log.length = 0;
  mockToast.mockClear();
  mockNotifyFailed.mockClear();
  mockUploadViaTus.mockReset();
  mockCancelTus.mockReset();
  mockCancelTus.mockImplementation(async () => {});
  mockIsTokenExpired.mockReset();
  mockIsTokenExpired.mockReturnValue(false);
  mockRequestViewLink.mockReset();
  mockRequestViewLink.mockResolvedValue(null);
  secure.links.clear();
  secure.deleted.length = 0;
});

// First: `prepareLaunch` runs once per manager, like once per app launch.
describe('launch check', () => {
  it('cancels orphaned transfers and clears temp files before anything uploads, then fails what a kill left uploading', async () => {
    // A draft a killed app left `uploading`, and one uploading live in this process.
    db.status.set('killed', 'uploading');
    // Uploaded earlier, with a view link that still works and one that has expired.
    db.status.set('shared', 'uploaded');
    secure.links.set('shared', { url: 'https://v/shared', expiresAt: Date.now() + 60_000 });
    db.status.set('stale', 'uploaded');
    secure.links.set('stale', { url: 'https://v/stale', expiresAt: Date.now() - 1 });
    let releaseOrphans: () => void = () => {};
    native.cancelOrphans = () =>
      new Promise<number>((resolve) => {
        releaseOrphans = () => resolve(1);
      });
    tusWith();

    const launch = uploads.prepareLaunch();
    // A claim during the launch check waits for it: nothing is written or uploaded yet.
    const claimed = claim('live');
    await new Promise((r) => setTimeout(r, 20));
    expect(db.log).toEqual([]);
    expect(mockUploadViaTus).not.toHaveBeenCalled();

    releaseOrphans();
    await launch;
    await claimed;
    await eventually(() => db.status.get('live') === 'uploaded');

    expect(native.log).toEqual(['cancel-orphans', 'cleanup-chunks']);
    expect(files.deletedDirs).toContain('uploads');
    // The killed upload failed cleanly and the user was told; the live one was never touched.
    expect(db.status.get('killed')).toBeNull();
    expect(db.log.indexOf('burn:killed')).toBeLessThan(db.log.indexOf('pair:live'));
    expect(db.log).not.toContain('burn:live');
    expect(mockToast).toHaveBeenCalledWith(
      'An upload didn’t finish — scan a new link to try again.',
    );
    // And a notification, for a launch in the background (a no-op in the foreground).
    expect(mockNotifyFailed).toHaveBeenCalled();
    // What the killed run created is left to server retention (its URLs died with it).
    expect(mockCancelTus).not.toHaveBeenCalled();
    // View links come back after a restart until they expire; expired ones are forgotten.
    await eventually(() => uploads.getWatchLink('shared') !== null);
    expect(uploads.getWatchLink('shared')).toMatchObject({
      url: 'https://v/shared',
      shareable: true,
    });
    expect(uploads.getWatchLink('stale')).toBeNull();
    expect(secure.links.has('stale')).toBe(false);
    // Idempotent: a second call is the same launch.
    expect(uploads.prepareLaunch()).toBe(launch);
  });
});

describe('upload', () => {
  it('claims (draft first, then the pool row), uploads the related files then the video, and settles uploaded', async () => {
    tusWith();
    await claim('d1');
    await eventually(() => db.status.get('d1') === 'uploaded');

    // The draft is paired `uploading` before the link is spent.
    const [paired] = jest.mocked(setUploadDestination).mock.invocationCallOrder.slice(-1);
    const [spent] = jest.mocked(deleteDestination).mock.invocationCallOrder.slice(-1);
    expect(paired).toBeLessThan(spent);
    expect(pool.log).toEqual(['pool-delete:dest-d1']);
    expect(pool.pool.has('dest-d1')).toBe(false);
    // Captions, manifest, thumbnail — each a fresh artifactId related to the video — then the video.
    const calls = mockUploadViaTus.mock.calls.map(([o]) => o);
    expect(calls.map((o) => o.kind)).toEqual(['captions', 'project', 'thumbnail', 'video']);
    for (const o of calls.slice(0, 3)) {
      expect(o.artifactId).toMatch(/^related-/);
      expect(o.relatedTo).toBe('art-dest-d1');
    }
    expect(new Set(calls.slice(0, 3).map((o) => o.artifactId)).size).toBe(3);
    expect(calls[3]).toMatchObject({
      artifactId: 'art-dest-d1',
      checksum: 'md5:deadbeef',
      name: 'My Draft',
    });

    expect(db.status.get('d1')).toBe('uploaded');
    // Finishing is an event: the draft is idle again, the user is told, and the tokened watch
    // link is kept for Home's ⋯ menu.
    expect(uploads.getDraftState('d1').status).toBe('idle');
    expect(mockToast).toHaveBeenCalledWith('Uploaded “My Draft”');
    // No view links on this server: the link carries the pairing token, so it's for the
    // user's own browser only — never offered for copying.
    expect(uploads.getWatchLink('d1')).toEqual({
      url: `${SERVER}/artifacts/art-dest-d1?token=tok`,
      expiresAt: null,
      shareable: false,
    });
    expect(mockRequestViewLink).not.toHaveBeenCalled();
    // A finished upload keeps everything it created; its temp files are gone.
    expect(mockCancelTus).not.toHaveBeenCalled();
    expect(files.deletedFiles).toEqual(
      expect.arrayContaining(['d1.vtt', 'd1-beats.pulse', 'd1.jpg']),
    );
  });

  it('names an unnamed draft’s upload as “your pulse”', async () => {
    jest.mocked(getDraftName).mockResolvedValueOnce(undefined);
    tusWith();
    await claim('d0');
    await eventually(() => db.status.get('d0') === 'uploaded');

    expect(mockToast).toHaveBeenCalledWith('Your pulse is uploaded');
  });

  it('a terminal failure unpairs the draft, DELETEs what the run created, and says why', async () => {
    tusWith(() => {
      throw Object.assign(new Error('Rejected'), { retryable: false });
    });
    await claim('d2');
    await eventually(() => db.log.includes('burn:d2'));
    await eventually(() => mockCancelTus.mock.calls.length === 4);

    expect(db.status.get('d2')).toBeNull();
    expect(uploads.getDraftState('d2').status).toBe('idle');
    expect(uploads.getWatchLink('d2')).toBeNull();
    // The instruction first (the toast shows two lines), then the reason and the step.
    expect(mockToast).toHaveBeenCalledWith(
      'Upload failed — scan a new link to try again. (Video: Rejected)',
    );
    // Scoped to its own link, so it can never unpair a newer claim.
    expect(jest.mocked(burnUploadPairing)).toHaveBeenCalledWith('d2', 'art-dest-d2');
    expect(mockNotifyFailed).toHaveBeenCalled();
    // The related files that landed AND the video's own upload.
    expect(mockCancelTus.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([`${SERVER}/upload/art-dest-d2`]),
    );
    expect(mockCancelTus.mock.calls.every(([, token]) => token === 'tok')).toBe(true);
    expect(files.deletedFiles).toEqual(expect.arrayContaining(['d2.vtt', 'd2-beats.pulse']));
    // The spent link is gone from the pool whatever happened.
    expect(pool.pool.has('dest-d2')).toBe(false);
  });

  it('fails an expired link at claim, without uploading', async () => {
    mockIsTokenExpired.mockReturnValue(true);
    await claim('d3');
    await eventually(() => mockToast.mock.calls.length > 0);

    expect(mockUploadViaTus).not.toHaveBeenCalled();
    expect(db.status.get('d3')).toBeNull();
    expect(mockToast).toHaveBeenCalledWith('Upload link expired — scan a new link to try again.');
    expect(uploads.getDraftState('d3').status).toBe('idle');
  });

  it('fails when the server no longer speaks a common protocol, before sending anything', async () => {
    jest
      .mocked(checkCapabilities)
      .mockResolvedValueOnce({ ok: false, reason: 'version-too-old' } as never);
    tusWith();
    await claim('d4');
    await eventually(() => db.log.includes('burn:d4'));

    expect(mockUploadViaTus).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(
      'This server needs a newer version of Pulse — update the app, then scan a new link.',
    );
  });

  it('says to update the app when the server answers 426 mid-upload', async () => {
    tusWith(() => {
      throw new TusUploadError('This server needs a newer version of Pulse.', {
        retryable: false,
        statusCode: 426,
      });
    });
    await claim('d5');
    await eventually(() => db.log.includes('burn:d5'));

    expect(mockToast).toHaveBeenCalledWith(
      'This server needs a newer version of Pulse — update the app, then scan a new link.',
    );
  });

  it('doesn’t wait on a failed upload’s DELETEs: the draft can be claimed again, and the next draft runs', async () => {
    // A server that stopped answering: the DELETEs hang (RN fetch has no timeout).
    mockCancelTus.mockImplementation(() => new Promise<void>(() => {}));
    tusWith(() => {
      throw Object.assign(new Error('Rejected'), { retryable: false });
    });
    await claim('h1');
    await eventually(
      () => uploads.getDraftState('h1').status === 'idle' && db.log.includes('burn:h1'),
    );

    tusWith();
    await claim('h2');
    await claim('h1', 'h1-second-link');
    await eventually(
      () => db.status.get('h2') === 'uploaded' && db.status.get('h1') === 'uploaded',
    );
    expect(db.status.get('h1')).toBe('uploaded');
    expect(db.artifact.get('h1')).toBe('art-h1-second-link');
    expect(uploads.getWatchLink('h1')?.url).toBe(
      `${SERVER}/artifacts/art-h1-second-link?token=tok`,
    );
  });
});

describe('cancel', () => {
  it('aborts the run, unpairs the draft and DELETEs everything it created — no failure message', async () => {
    videoHangsUntilAborted();
    await claim('c1');
    await eventually(() => videoCalls().length > 0);

    await uploads.cancel('c1');
    expect(db.status.get('c1')).toBeNull();
    expect(uploads.getDraftState('c1').status).toBe('idle');
    expect(uploads.getWatchLink('c1')).toBeNull();
    // The three related files and the in-flight video.
    expect(mockCancelTus).toHaveBeenCalledTimes(4);
    expect(mockCancelTus).toHaveBeenCalledWith(`${SERVER}/upload/art-dest-c1`, 'tok');
    await new Promise((r) => setTimeout(r, 20));
    expect(mockToast).not.toHaveBeenCalled();
    expect(mockNotifyFailed).not.toHaveBeenCalled();
    expect(db.log).not.toContain('uploaded:c1');
  });

  it('stops an upload cancelled while the Android foreground service is starting', async () => {
    let started: () => void = () => {};
    jest.mocked(keepAlive.begin).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          started = resolve;
        }),
    );
    tusWith();
    await claim('c0');
    await eventually(() => jest.mocked(keepAlive.begin).mock.calls.length > 0);

    await uploads.cancel('c0');
    started();
    await new Promise((r) => setTimeout(r, 20));

    expect(mockUploadViaTus).not.toHaveBeenCalled();
    expect(uploads.getDraftState('c0').status).toBe('idle');
    expect(db.status.get('c0')).toBeNull();
  });

  it('never clears an upload that finished first', async () => {
    tusWith();
    await claim('c2');
    await eventually(() => db.status.get('c2') === 'uploaded');

    await uploads.cancel('c2');
    expect(db.status.get('c2')).toBe('uploaded');
    expect(uploads.getWatchLink('c2')).not.toBeNull();
    expect(mockCancelTus).not.toHaveBeenCalled();
  });

  it('wins over a finish that lands after it: the run resets and DELETEs what it created', async () => {
    // The cancel's unpairing lands while the video's last bytes do, and the transfer then ticks
    // 100% after the cancel's reset.
    tusWith((opts) => {
      db.status.set('c3', null);
      opts.onProgress?.({ bytesSent: 1024, totalBytes: 1024 });
    });
    await claim('c3');
    await eventually(() => mockCancelTus.mock.calls.length === 4);

    expect(db.log).not.toContain('uploaded:c3');
    expect(uploads.getDraftState('c3').status).toBe('idle');
    expect(uploads.getWatchLink('c3')).toBeNull();
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('DELETEs an upload created after the cancel', async () => {
    let createLate: () => void = () => {};
    mockUploadViaTus.mockImplementation(async (opts) => {
      if (opts.kind !== 'video') return { resourceUrl: created(opts) };
      // The create's response arrives after the cancel.
      await new Promise<void>((resolve) => {
        createLate = resolve;
      });
      created(opts);
      throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    });
    await claim('c4');
    await eventually(() => videoCalls().length > 0);

    await uploads.cancel('c4');
    createLate();
    await eventually(() =>
      mockCancelTus.mock.calls.some(([url]) => url === `${SERVER}/upload/art-dest-c4`),
    );
  });
});

describe('claim', () => {
  it('uploads a link once when two drafts claim it; the other is unpaired', async () => {
    tusWith();
    await Promise.all([claim('r1', 'shared'), claim('r2', 'shared')]);
    await eventually(() => db.status.get('r1') === 'uploaded');

    expect(videoCalls()).toHaveLength(1);
    expect(db.status.get('r1')).toBe('uploaded');
    expect(db.status.get('r2')).toBeNull();
    // Not reachable from the UI (one export screen at a time), so the loser tells the user
    // nothing; the only toast is the winner's.
    expect(mockToast.mock.calls).toEqual([['Uploaded “My Draft”']]);
  });

  it('a cancel that lands mid-claim stops the upload before it starts', async () => {
    jest.mocked(deleteDestination).mockImplementationOnce(async (id: string) => {
      // The draft is `uploading` now, so Home's ⋯ menu offers Cancel.
      await uploads.cancel('m1');
      return pool.pool.delete(id);
    });
    tusWith();
    await claim('m1');
    await new Promise((r) => setTimeout(r, 20));

    expect(mockUploadViaTus).not.toHaveBeenCalled();
    expect(db.status.get('m1')).toBeNull();
    expect(uploads.getDraftState('m1').status).toBe('idle');
  });

  it('unpairs the draft and says so when the claim can’t be written', async () => {
    jest.mocked(deleteDestination).mockRejectedValueOnce(new Error('disk full'));
    tusWith();
    await claim('e1');

    expect(db.status.get('e1')).toBeNull();
    expect(mockToast).toHaveBeenCalledWith('Couldn’t start the upload — try again.');
    expect(mockUploadViaTus).not.toHaveBeenCalled();
  });

  it('ignores a double tap on the same draft', async () => {
    videoHangsUntilAborted();
    await Promise.all([claim('t1'), claim('t1', 'dest-t1-again')]);
    await eventually(() => videoCalls().length > 0);
    await new Promise((r) => setTimeout(r, 20));

    expect(db.log.filter((e) => e === 'pair:t1')).toHaveLength(1);
    expect(videoCalls()).toHaveLength(1);
    // The second link wasn't spent.
    expect(pool.pool.has('dest-t1-again')).toBe(true);
    await uploads.cancel('t1');
  });
});

describe('drain', () => {
  it('runs an upload claimed while the drain is shutting down the foreground service', async () => {
    tusWith();
    jest.mocked(keepAlive.end).mockImplementationOnce(async () => {
      await claim('late');
    });
    await claim('first');
    await eventually(() => db.status.get('first') === 'uploaded');
    await eventually(() => db.status.get('late') === 'uploaded');

    expect(db.status.get('late')).toBe('uploaded');
  });
});

describe('view links', () => {
  const withViewLinks = () =>
    jest
      .mocked(checkCapabilities)
      .mockResolvedValueOnce({ ok: true, capabilities: { viewLinks: true } } as never);

  it('asks a server with view links for one, and keeps it as the shareable link', async () => {
    withViewLinks();
    const link = { url: 'https://v/view?token=read-only', expiresAt: Date.now() + 86_400_000 };
    mockRequestViewLink.mockResolvedValueOnce(link);
    tusWith();
    await claim('v1');
    await eventually(() => db.status.get('v1') === 'uploaded');

    expect(mockRequestViewLink).toHaveBeenCalledWith(
      expect.objectContaining({ server: SERVER, artifactId: 'art-dest-v1', token: 'tok' }),
    );
    await eventually(() => uploads.getWatchLink('v1')?.shareable === true);
    expect(uploads.getWatchLink('v1')).toEqual({ ...link, shareable: true });
    await eventually(() => secure.links.has('v1'));
    expect(secure.links.get('v1')).toEqual(link);
  });

  it('records the upload before asking for a link, and a server that never answers holds up nothing', async () => {
    withViewLinks();
    mockRequestViewLink.mockImplementationOnce(() => new Promise(() => {}));
    tusWith();
    await claim('v0');
    await eventually(() => mockRequestViewLink.mock.calls.length > 0);

    // Already uploaded and announced, with the direct link for the user's own browser.
    expect(db.status.get('v0')).toBe('uploaded');
    expect(mockToast).toHaveBeenCalledWith('Uploaded “My Draft”');
    expect(uploads.getWatchLink('v0')).toMatchObject({ shareable: false });
    // The next upload isn't queued behind the unanswered request.
    await claim('v0b');
    await eventually(() => db.status.get('v0b') === 'uploaded');
  });

  it('falls back to a link for the user alone when the server can’t mint one', async () => {
    withViewLinks();
    tusWith();
    await claim('v2');
    await eventually(() => db.status.get('v2') === 'uploaded');

    expect(mockRequestViewLink).toHaveBeenCalled();
    expect(uploads.getWatchLink('v2')).toMatchObject({ shareable: false });
    expect(secure.links.has('v2')).toBe(false);
  });

  it('shares a tokenless link, which carries no secret', async () => {
    tusWith();
    pool.pool.add('open-link');
    await uploads.claim({
      draftId: 'v3',
      destinationId: 'open-link',
      destination: { server: SERVER, token: null, artifactId: 'art-open' },
      segments: [],
      merged: { path: '/drafts/v3/export.mp4', durationMs: 1000 },
    });
    await eventually(() => db.status.get('v3') === 'uploaded');

    expect(uploads.getWatchLink('v3')).toEqual({
      url: `${SERVER}/artifacts/art-open`,
      expiresAt: null,
      shareable: true,
    });
  });

  it('a new upload of the draft replaces its previous link', async () => {
    withViewLinks();
    mockRequestViewLink.mockResolvedValueOnce({
      url: 'https://v/old',
      expiresAt: Date.now() + 60_000,
    });
    tusWith();
    await claim('v4');
    await eventually(() => secure.links.has('v4'));

    videoHangsUntilAborted();
    await claim('v4', 'v4-second-link');
    await eventually(() => videoCalls().length > 0);

    expect(uploads.getWatchLink('v4')).toBeNull();
    expect(secure.links.has('v4')).toBe(false);
    await uploads.cancel('v4');
  });
});
