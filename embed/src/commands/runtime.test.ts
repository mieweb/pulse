import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { JobState } from '@/db/upload-jobs';

// commands/runtime.ts as PulseKit drives it: its modules are fakes that record what the runtime
// did, and BrownfieldMessaging is a bus the test plays native on.

type Message = Record<string, unknown>;
type MockMessage = Message;
type MockListener = (message: MockMessage) => void;

jest.mock('expo-brownfield', () => {
  const listeners = new Set<MockListener>();
  const sent: MockMessage[] = [];
  return {
    sent,
    sendMessage: (message: MockMessage) => void sent.push(message),
    addMessageListener: (listener: MockListener) => {
      listeners.add(listener);
      return { remove: () => void listeners.delete(listener) };
    },
    deliver: (message: MockMessage) => [...listeners].forEach((l) => l(message)),
  };
});
jest.mock('@/db/client', () => ({
  db: {},
  expoDb: { closeSync: jest.fn() },
  library: { failed: false },
}));
jest.mock('@/db/migrate', () => ({ runMigrations: jest.fn(async () => {}) }));
jest.mock('@/features/logs/logger', () => ({ installLogCapture: jest.fn() }));
const mockFlushDraftWrites = jest.fn<() => Promise<void>>(async () => {});
const mockWaitForUndoHistory = jest.fn<() => Promise<void>>(async () => {});
const mockRename = jest.fn<() => Promise<void>>(async () => {});
jest.mock('@/features/editor/draft-writes', () => ({
  flushDraftWrites: () => mockFlushDraftWrites(),
}));
jest.mock('@/core/undo-write-barrier', () => ({
  waitForUndoHistory: () => mockWaitForUndoHistory(),
}));
jest.mock('@/db/upload-jobs', () => ({
  ...jest.requireActual<typeof import('@/db/upload-jobs')>('@/db/upload-jobs'),
  listUploadJobs: jest.fn(() => []),
  subscribeUploadJobs: jest.fn(() => () => {}),
}));
jest.mock('@/core/network', () => ({ isOnline: () => true, setNetworkSource: jest.fn() }));
jest.mock('@/features/drafts/catalog-writer', () => ({
  startCatalogWriter: jest.fn(async () => {}),
  stopCatalogWriter: jest.fn(async () => {}),
}));
jest.mock('@/features/transcription/clip-queue', () => ({
  clearClipQueue: jest.fn(async () => {}),
}));
jest.mock('@/features/transcription/vad', () => ({ releaseVad: jest.fn(async () => {}) }));
jest.mock('@/features/transcription/whisper', () => ({ releaseWhisper: jest.fn(async () => {}) }));
jest.mock('@/features/upload/core/host-services', () => ({
  setHostRequestSink: jest.fn(),
  respondToHostRequest: jest.fn(),
  hostRequestTimedOut: jest.fn(),
}));
jest.mock('@/features/upload/core/native-chunk-upload', () => ({
  setBackgroundUploads: jest.fn(),
}));
jest.mock('@/features/upload/core/runner', () => {
  const runner = {
    setAccountActive: jest.fn(),
    subscribeProgress: jest.fn(() => () => {}),
    start: jest.fn(() => () => {}),
    boot: jest.fn(async () => {}),
    idle: jest.fn<() => Promise<void>>(async () => {}),
    runJob: jest.fn(async () => {}),
    resumeOutbox: jest.fn(async () => {}),
  };
  return { runner, createJobRunner: () => runner };
});
// The library's deps as the runtime builds them, over one draft 'd1' with no job: the runtime's
// own pieces (uploadMode, heldDraft, changed) are kept, the rest are fakes.
jest.mock('./library', () => ({
  libraryDeps: (input: { uploadMode: unknown; heldDraft: unknown; changed: unknown }) => ({
    draft: (id: string) => (id === 'd1' ? { jobState: null, clockBound: false } : null),
    hasReceipt: () => false,
    newerSchema: () => false,
    heldDraft: input.heldDraft,
    uploadMode: input.uploadMode,
    cancelJob: () => {},
    rename: () => mockRename(),
    remove: async () => {},
    setContext: async () => {},
    send: async (id: string) => ({ clientKey: `ck-${id}`, draftKey: `dk-${id}`, sentAt: 1 }),
    retireFile: () => {},
    recheck: () => {},
    dismissReceipt: () => false,
    resumeOutbox: async () => {},
    changed: input.changed,
  }),
}));

type Bus = { sent: Message[]; deliver(m: Message): void };
type RunnerFake = { setAccountActive: jest.Mock; idle: jest.Mock<() => Promise<void>> };

/** A fresh runtime module (its services are once per runtime), and its fakes. */
function boot(props: { config?: unknown; jobs?: JobState[] } = {}) {
  let runtime!: typeof import('./runtime');
  let bus!: Bus;
  let fakes!: {
    setBackgroundUploads: jest.Mock;
    runner: RunnerFake;
    closeSync: jest.Mock;
    listUploadJobs: jest.Mock;
  };
  jest.isolateModules(() => {
    runtime = jest.requireActual('./runtime');
    bus = jest.requireMock('expo-brownfield');
    fakes = {
      setBackgroundUploads: jest.requireMock<{ setBackgroundUploads: jest.Mock }>(
        '@/features/upload/core/native-chunk-upload',
      ).setBackgroundUploads,
      runner: jest.requireMock<{ runner: RunnerFake }>('@/features/upload/core/runner').runner,
      closeSync: jest.requireMock<{ expoDb: { closeSync: jest.Mock } }>('@/db/client').expoDb
        .closeSync,
      listUploadJobs: jest.requireMock<{ listUploadJobs: jest.Mock }>('@/db/upload-jobs')
        .listUploadJobs,
    };
  });
  fakes.listUploadJobs.mockImplementation(() =>
    (props.jobs ?? []).map((state) => ({ state }) as never),
  );
  const services = runtime.startRuntimeServices({
    namespace: 'acct',
    config: props.config,
    network: { online: true, wifi: true, expensive: false },
  });
  let n = 0;
  /** Play native: a `pulse.cmd`, answered by the runtime's `pulse.reply`. */
  async function cmd(method: string, args: Message = {}): Promise<Message> {
    const callId = `t-${++n}`;
    bus.deliver({ type: 'pulse.cmd', callId, method, args });
    for (let i = 0; i < 50; i++) {
      const reply = bus.sent.find((m) => m.type === 'pulse.reply' && m.callId === callId);
      if (reply) return reply;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`no reply to ${method}`);
  }
  return { runtime, services, bus, fakes, cmd };
}

const errorCode = (reply: Message) => (reply.error as { code?: string } | undefined)?.code;

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockFlushDraftWrites.mockReset().mockResolvedValue();
  mockWaitForUndoHistory.mockReset().mockResolvedValue();
  mockRename.mockReset().mockResolvedValue();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the embedded runtime (commands/runtime.ts)', () => {
  it('starts once, says pulse.ready, and hands native-chunk-upload a PulseKit transport', () => {
    const { runtime, services, bus, fakes } = boot({ config: { uploadMode: 'pulse' } });
    expect(services?.namespace).toBe('acct');
    expect(runtime.startRuntimeServices({ namespace: 'other' })).toBe(services);
    expect(bus.sent).toContainEqual({ type: 'pulse.ready', namespace: 'acct' });
    expect(fakes.setBackgroundUploads).toHaveBeenCalledTimes(1);
    const transport = fakes.setBackgroundUploads.mock.calls[0][0] as {
      send(m: Message): void;
      listen(on: (m: Message) => void): () => void;
    };
    // Its ops go out over BrownfieldMessaging, and only the uploader's answers come back.
    transport.send({ type: 'pulse.upload', op: 'hello' });
    expect(bus.sent).toContainEqual({ type: 'pulse.upload', op: 'hello' });
    const heard: Message[] = [];
    transport.listen((m) => void heard.push(m));
    bus.deliver({ type: 'pulse.upload.end', id: 'u1' });
    bus.deliver({ type: 'pulse.cmd', callId: 'x', method: 'nothing' });
    expect(heard).toEqual([{ type: 'pulse.upload.end', id: 'u1' }]);
  });

  it('upload reads uploadMode per call: a configure after boot reaches a warm runtime', async () => {
    const { cmd } = boot({ config: { uploadMode: 'file' } });
    expect(errorCode(await cmd('upload', { id: 'd1' }))).toBe('host_misconfigured');
    expect(await cmd('configure', { uploadMode: 'pulse' })).toMatchObject({ ok: true });
    expect(await cmd('upload', { id: 'd1' })).toMatchObject({
      ok: true,
      result: { clientKey: 'ck-d1', draftKey: 'dk-d1', sentAt: 1 },
    });
    await cmd('configure', { uploadMode: 'file' });
    expect(errorCode(await cmd('upload', { id: 'd1' }))).toBe('host_misconfigured');
  });

  it('accountActive reaches the job loop’s setAccountActive', async () => {
    const { cmd, fakes } = boot();
    await cmd('resumeOutbox'); // waits for the library gate, so the loop exists
    fakes.runner.setAccountActive.mockClear();
    await cmd('accountActive', { active: false });
    await cmd('accountActive', { active: true });
    expect(fakes.runner.setAccountActive.mock.calls).toEqual([[false], [true]]);
  });

  it('releaseLibrary refuses while a flow is open; then closes the library and says released', async () => {
    const { services, cmd, bus, fakes } = boot();
    const close = services!.lifetime.flowOpened();
    expect(errorCode(await cmd('releaseLibrary'))).toBe('busy');
    expect(fakes.closeSync).not.toHaveBeenCalled();
    close();
    expect(await cmd('releaseLibrary')).toMatchObject({ ok: true });
    expect(fakes.closeSync).toHaveBeenCalledTimes(1);
    expect(fakes.setBackgroundUploads).toHaveBeenLastCalledWith(null);
    expect(bus.sent).toContainEqual({ type: 'pulse.released', namespace: 'acct' });
    // Its commands are gone: PulseKit sends it nothing more after pulse.released.
    expect(errorCode(await cmd('upload', { id: 'd1' }))).toBe('method.unsupported');
  });

  it('waits for a paused upload pass before editor barriers, close and release acknowledgement', async () => {
    const { cmd, bus, fakes } = boot();
    await cmd('resumeOutbox');
    let settled!: () => void;
    fakes.runner.idle.mockImplementationOnce(() => {
      expect(fakes.runner.setAccountActive).toHaveBeenLastCalledWith(false);
      return new Promise<void>((resolve) => {
        settled = resolve;
      });
    });
    const first = cmd('releaseLibrary');
    const second = cmd('releaseLibrary');
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    expect(fakes.runner.idle).toHaveBeenCalledTimes(1);
    expect(mockFlushDraftWrites).not.toHaveBeenCalled();
    expect(mockWaitForUndoHistory).not.toHaveBeenCalled();
    expect(fakes.closeSync).not.toHaveBeenCalled();
    expect(bus.sent.some((message) => message.type === 'pulse.released')).toBe(false);
    expect(errorCode(await cmd('renameDraft', { id: 'd1', name: 'late' }))).toBe('busy');
    expect(mockRename).not.toHaveBeenCalled();
    // An account-active notification must not wake another pass while release is draining.
    await cmd('accountActive', { active: true });
    expect(fakes.runner.setAccountActive).toHaveBeenLastCalledWith(false);

    settled();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(mockFlushDraftWrites).toHaveBeenCalledTimes(1);
    expect(mockWaitForUndoHistory).toHaveBeenCalledTimes(1);
    expect(fakes.closeSync).toHaveBeenCalledTimes(1);
    expect(bus.sent.filter((message) => message.type === 'pulse.released')).toHaveLength(1);
  });

  it('keeps command admission and upload pause retryable when waiting for the runner fails', async () => {
    const { cmd, bus, fakes } = boot();
    await cmd('resumeOutbox');
    fakes.runner.idle.mockRejectedValueOnce(new Error('upload pass did not settle'));
    expect(await cmd('releaseLibrary')).toMatchObject({ ok: false });
    expect(mockFlushDraftWrites).not.toHaveBeenCalled();
    expect(mockWaitForUndoHistory).not.toHaveBeenCalled();
    expect(fakes.closeSync).not.toHaveBeenCalled();
    expect(fakes.runner.setAccountActive).toHaveBeenLastCalledWith(true);
    expect(bus.sent.some((message) => message.type === 'pulse.released')).toBe(false);
    expect(await cmd('renameDraft', { id: 'd1', name: 'still open' })).toMatchObject({ ok: true });

    expect(await cmd('releaseLibrary')).toMatchObject({ ok: true });
    expect(fakes.runner.idle).toHaveBeenCalledTimes(2);
    expect(fakes.closeSync).toHaveBeenCalledTimes(1);
  });

  it('keeps SQLite open until dismissed editor writes and Undo checkpoints finish', async () => {
    const { cmd, bus, fakes } = boot();
    await cmd('resumeOutbox');
    let edited!: () => void;
    let checkpointed!: () => void;
    mockFlushDraftWrites.mockReturnValue(
      new Promise((resolve) => {
        edited = resolve;
      }),
    );
    mockWaitForUndoHistory.mockReturnValue(
      new Promise((resolve) => {
        checkpointed = resolve;
      }),
    );
    const releasing = cmd('releaseLibrary');
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    expect(mockFlushDraftWrites).toHaveBeenCalledTimes(1);
    expect(mockWaitForUndoHistory).not.toHaveBeenCalled();
    expect(fakes.closeSync).not.toHaveBeenCalled();
    edited();
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    expect(mockWaitForUndoHistory).toHaveBeenCalledTimes(1);
    expect(fakes.closeSync).not.toHaveBeenCalled();
    expect(bus.sent.some((message) => message.type === 'pulse.released')).toBe(false);
    expect(errorCode(await cmd('renameDraft', { id: 'd1', name: 'late' }))).toBe('busy');
    expect(mockRename).not.toHaveBeenCalled();

    checkpointed();
    expect(await releasing).toMatchObject({ ok: true });
    expect(fakes.closeSync).toHaveBeenCalledTimes(1);
    expect(bus.sent).toContainEqual({ type: 'pulse.released', namespace: 'acct' });
  });

  it('keeps its command handlers and library available when a shutdown checkpoint fails', async () => {
    const { cmd, bus, fakes } = boot();
    mockWaitForUndoHistory.mockRejectedValueOnce(new Error('disk full'));
    expect(await cmd('releaseLibrary')).toMatchObject({ ok: false });
    expect(fakes.closeSync).not.toHaveBeenCalled();
    expect(fakes.runner.setAccountActive).toHaveBeenLastCalledWith(true);
    expect(bus.sent.some((message) => message.type === 'pulse.released')).toBe(false);
    expect(await cmd('configure', { uploadMode: 'file' })).toMatchObject({ ok: true });

    expect(await cmd('releaseLibrary')).toMatchObject({ ok: true });
    expect(fakes.closeSync).toHaveBeenCalledTimes(1);
  });

  it('refuses shutdown while an admitted library command is still writing', async () => {
    const { cmd, fakes } = boot();
    await cmd('resumeOutbox');
    let renamed!: () => void;
    mockRename.mockReturnValue(
      new Promise((resolve) => {
        renamed = resolve;
      }),
    );
    const renaming = cmd('renameDraft', { id: 'd1', name: 'new name' });
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(errorCode(await cmd('releaseLibrary'))).toBe('busy');
    expect(fakes.closeSync).not.toHaveBeenCalled();

    renamed();
    expect(await renaming).toMatchObject({ ok: true });
    expect(await cmd('releaseLibrary')).toMatchObject({ ok: true });
    expect(fakes.closeSync).toHaveBeenCalledTimes(1);
  });

  it('a memory warning with an active job keeps the library open and says nothing more', async () => {
    const { cmd, bus, fakes } = boot({ jobs: ['uploading'] });
    expect(await cmd('memoryWarning')).toMatchObject({ ok: true, result: { release: false } });
    expect(fakes.closeSync).not.toHaveBeenCalled();
    expect(bus.sent.some((m) => m.type === 'pulse.released')).toBe(false);
  });

  it('an idle memory warning releases the library and says pulse.released before its reply', async () => {
    const { cmd, bus, fakes } = boot({ jobs: ['needs_credentials'] });
    expect(await cmd('memoryWarning')).toMatchObject({ ok: true, result: { release: true } });
    expect(fakes.closeSync).toHaveBeenCalledTimes(1);
    const types = bus.sent.map((m) => m.type);
    expect(types).toContain('pulse.released');
    expect(types.indexOf('pulse.released')).toBeLessThan(types.lastIndexOf('pulse.reply'));
  });
});
