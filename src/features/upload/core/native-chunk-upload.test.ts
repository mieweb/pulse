import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * The `pulse.upload` transport (native-chunk-upload.ts) against a fake PulseKit, on both platforms
 * PulseKit answers it: PulseKitBackground.swift on iOS and PulseKitUploads.kt on Android. The
 * launch rule's sweep runs on both; expo-file-system's task cancel stays iOS-only.
 */
const mockCancelExpoTasks = jest.fn(async () => 3);

jest.mock('expo', () => ({
  requireOptionalNativeModule: () => ({ cancelBackgroundUploadTasks: mockCancelExpoTasks }),
}));
jest.mock('expo-file-system', () => ({
  Directory: jest.fn(),
  File: jest.fn(),
  FileMode: {},
  UploadType: {},
}));
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('@/utils/storage-root', () => ({
  cacheDir: jest.fn(),
  customDocumentsPath: jest.fn(() => null),
}));
jest.mock('./upload-log', () => ({
  ...jest.requireActual<typeof import('./upload-log')>('./upload-log'),
  uploadLog: { info: () => {}, warn: () => {} },
}));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import { Platform } from 'react-native';

import {
  attachRunningUpload,
  type BackgroundTransport,
  cancelOrphanedUploadTasks,
  setBackgroundUploads,
  uploadChunkNative,
} from './native-chunk-upload';
import { customDocumentsPath } from '@/utils/storage-root';
/* eslint-enable import/first */

type Message = Record<string, unknown>;

const ROOT_IOS = '/var/mobile/Containers/Data/Application/X/Library/PulseKit/acct-1';
const ROOT_ANDROID = '/data/user/0/com.example.host/files/PulseKit/acct-1';
const URL = 'https://vault.example.org/upload/u1';

function setPlatform(os: string): void {
  (Platform as { OS: string }).OS = os;
}

/** A PulseKit that answers each message with `answer` (asynchronously, as BrownfieldMessaging). */
function fakePulseKit(answer: (m: Message, reply: (r: Message) => void) => void) {
  const sent: Message[] = [];
  let deliver: ((m: Message) => void) | null = null;
  const transport: BackgroundTransport = {
    send: (m) => {
      sent.push(m);
      queueMicrotask(() => answer(m, (r) => deliver?.({ id: m.id, ...r })));
    },
    listen: (fn) => {
      deliver = fn;
      return () => {
        deliver = null;
      };
    },
  };
  setBackgroundUploads(transport);
  return { sent, ops: () => sent.map((m) => m.op) };
}

const hello = (m: Message, reply: (r: Message) => void) => {
  if (m.op === 'hello') reply({ type: 'pulse.upload.end', ok: true });
};

function patchArgs(signal?: AbortSignal) {
  return {
    resourceUrl: URL,
    kind: 'video' as const,
    offset: 40,
    chunkBytes: 60,
    totalBytes: 100,
    file: { uri: `file://${ROOT_ANDROID}/drafts/d1/send/video%20one.mp4` } as never,
    headers: { 'Upload-Offset': '40', Authorization: 'Bearer t' },
    signal,
  };
}

afterEach(() => {
  setBackgroundUploads(null);
  jest.mocked(customDocumentsPath).mockReturnValue(null);
  mockCancelExpoTasks.mockClear();
  setPlatform('ios');
});

describe.each(['android', 'ios'])('on %s', (os) => {
  const root = os === 'ios' ? ROOT_IOS : ROOT_ANDROID;

  beforeEach(() => setPlatform(os));

  it('uses PulseKit once it answers hello: the PATCH goes over the transport', async () => {
    const pk = fakePulseKit((m, reply) => {
      hello(m, reply);
      if (m.op === 'patch') {
        reply({ type: 'pulse.upload.progress', sent: 25 });
        reply({ type: 'pulse.upload.progress', sent: 60 });
        reply({
          type: 'pulse.upload.end',
          ok: true,
          status: 204,
          headers: { 'Upload-Offset': '100' },
        });
      }
    });
    const ticks: number[] = [];
    const result = await uploadChunkNative({ ...patchArgs(), onProgress: (n) => ticks.push(n) });
    expect(result).toEqual({ status: 204, headers: { 'Upload-Offset': '100' } });
    expect(ticks).toEqual([25, 60]);
    expect(pk.ops()).toEqual(['hello', 'patch']);
    expect(pk.sent[1]).toEqual({
      type: 'pulse.upload',
      op: 'patch',
      id: expect.any(String),
      url: URL,
      offset: 40,
      length: 60,
      // A plain path, decoded: PulseKit opens the file itself.
      path: `${ROOT_ANDROID}/drafts/d1/send/video one.mp4`,
      headers: { 'Upload-Offset': '40', Authorization: 'Bearer t' },
    });
  });

  it('resolves an HTTP error as an answer (tus-client reads the status)', async () => {
    fakePulseKit((m, reply) => {
      hello(m, reply);
      if (m.op === 'patch') reply({ type: 'pulse.upload.end', ok: true, status: 409, headers: {} });
    });
    await expect(uploadChunkNative(patchArgs())).resolves.toEqual({ status: 409, headers: {} });
  });

  it('rejects an end with error.canceled as an AbortError', async () => {
    fakePulseKit((m, reply) => {
      hello(m, reply);
      if (m.op === 'patch') {
        reply({
          type: 'pulse.upload.end',
          ok: false,
          error: { message: 'Cancelled.', canceled: true },
        });
      }
    });
    await expect(uploadChunkNative(patchArgs())).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Cancelled.',
    });
  });

  it('rejects a failed call that was not cancelled as a plain error (the job resumes)', async () => {
    fakePulseKit((m, reply) => {
      hello(m, reply);
      if (m.op === 'patch') {
        reply({
          type: 'pulse.upload.end',
          ok: false,
          error: { message: 'Android’s time limit ran out.', canceled: false },
        });
      }
    });
    const failure = await uploadChunkNative(patchArgs()).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('Error');
    expect((failure as Error).message).toBe('Android’s time limit ran out.');
  });

  it('sends cancel for the PATCH it aborts', async () => {
    const pk = fakePulseKit((m, reply) => {
      hello(m, reply);
      if (m.op === 'cancel') {
        reply({
          type: 'pulse.upload.end',
          ok: false,
          error: { message: 'Cancelled.', canceled: true },
        });
      }
    });
    const abort = new AbortController();
    const patch = uploadChunkNative(patchArgs(abort.signal));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    abort.abort();
    await expect(patch).rejects.toMatchObject({ name: 'AbortError' });
    const patchId = pk.sent.find((m) => m.op === 'patch')?.id;
    expect(pk.sent.find((m) => m.op === 'cancel')).toEqual({
      type: 'pulse.upload',
      op: 'cancel',
      id: patchId,
    });
  });

  it('attaches to a running call, or answers null when none runs', async () => {
    fakePulseKit((m, reply) => {
      hello(m, reply);
      if (m.op === 'attach' && m.url === `${URL}/none`) {
        reply({ type: 'pulse.upload.end', ok: true, attached: false });
      }
      if (m.op === 'attach' && m.url === URL) {
        reply({ type: 'pulse.upload.progress', sent: 80 });
        reply({ type: 'pulse.upload.end', ok: true, status: 204, headers: {} });
      }
    });
    const file = { uri: `file://${root}/drafts/d1/send/video.mp4` } as never;
    await expect(attachRunningUpload(`${URL}/none`, file)).resolves.toBeNull();
    const offsets: number[] = [];
    await expect(
      attachRunningUpload(URL, file, { onProgress: (n) => offsets.push(n) }),
    ).resolves.toEqual({ status: 204, headers: {} });
    expect(offsets).toEqual([80]);
  });

  it("sweeps PulseKit's calls at launch with the namespace root and the live list", async () => {
    const pk = fakePulseKit((m, reply) => {
      hello(m, reply);
      if (m.op === 'sweep') reply({ type: 'pulse.upload.end', ok: true, cancelled: 2 });
    });
    jest.mocked(customDocumentsPath).mockReturnValue(root);
    const cancelled = await cancelOrphanedUploadTasks([URL]);
    expect(pk.sent.find((m) => m.op === 'sweep')).toEqual({
      type: 'pulse.upload',
      op: 'sweep',
      id: expect.any(String),
      root,
      live: [URL],
    });
    // iOS adds the tasks expo-file-system's own session dropped (3 in the fake).
    expect(cancelled).toBe(os === 'ios' ? 5 : 2);
  });

  it("cancels expo-file-system's background tasks on iOS only", async () => {
    await expect(cancelOrphanedUploadTasks()).resolves.toBe(os === 'ios' ? 3 : 0);
    expect(mockCancelExpoTasks).toHaveBeenCalledTimes(os === 'ios' ? 1 : 0);
  });

  it('sends no sweep without PulseKit, a namespace root or a live list', async () => {
    jest.mocked(customDocumentsPath).mockReturnValue(root);
    await cancelOrphanedUploadTasks([URL]); // no transport at all
    const pk = fakePulseKit(hello);
    jest.mocked(customDocumentsPath).mockReturnValue(null);
    await cancelOrphanedUploadTasks([URL]); // no root (the Pulse app)
    jest.mocked(customDocumentsPath).mockReturnValue(root);
    await cancelOrphanedUploadTasks(); // no live list (the Pulse app's upload manager)
    expect(pk.ops()).not.toContain('sweep');
  });
});

it('does nothing on other platforms', async () => {
  setPlatform('web');
  const pk = fakePulseKit((m, reply) => {
    hello(m, reply);
    if (m.op === 'sweep') reply({ type: 'pulse.upload.end', ok: true, cancelled: 1 });
  });
  jest.mocked(customDocumentsPath).mockReturnValue(ROOT_ANDROID);
  await expect(cancelOrphanedUploadTasks([URL])).resolves.toBe(0);
  expect(pk.sent).toEqual([]);
  expect(mockCancelExpoTasks).not.toHaveBeenCalled();
});
