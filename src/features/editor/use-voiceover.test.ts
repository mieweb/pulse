import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import type { VoiceoverTake } from '@mieweb/pulse-editor';

import type { NewVoiceoverTake } from '@/db/voiceovers';

import type { PreviewTransport } from './use-preview-transport';
import { useVoiceover } from './use-voiceover';

// Exercise the public hook controls and real session while controlling native capture and
// durable-write completions. These checks do not simulate microphone timing or native seeks.
let mockSlots: unknown[] = [];
let mockSlot = 0;
let mockEffects: (() => void | (() => void))[] = [];
let cleanup: (() => void) | undefined;
function mockUseState<T>(initial: T | (() => T)) {
  const index = mockSlot++;
  if (!(index in mockSlots)) {
    mockSlots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
  }
  return [
    mockSlots[index] as T,
    (next: T) => {
      mockSlots[index] = next;
    },
  ] as const;
}
function mockUseRef<T>(initial: T) {
  const index = mockSlot++;
  if (!(index in mockSlots)) mockSlots[index] = { current: initial };
  return mockSlots[index] as { current: T };
}
jest.mock('react', () => ({
  useState: mockUseState,
  useRef: mockUseRef,
  useMemo: (calculate: () => unknown) => calculate(),
  useEffect: (effect: () => void | (() => void)) => mockEffects.push(effect),
}));
jest.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
jest.mock('drizzle-orm/expo-sqlite', () => ({ useLiveQuery: () => ({ data: [] }) }));
const mockAddTake = jest.fn<(input: NewVoiceoverTake) => Promise<unknown>>();
const mockUndoTake = jest.fn<(draftId: string) => Promise<{ playheadMs: number } | null>>();
jest.mock('@/db/voiceovers', () => ({
  voiceoverTakesQuery: () => [],
  voiceoverSettingsQuery: () => [],
  addVoiceoverTake: (input: NewVoiceoverTake) => mockAddTake(input),
  undoVoiceoverTake: (draftId: string) => mockUndoTake(draftId),
}));
jest.mock('@/utils/audio-session', () => ({ claimAudioSession: () => {} }));
jest.mock('@/utils/file-store', () => ({ deleteQuietly: () => {} }));
jest.mock('@/utils/user-message', () => ({ userMessage: (error: Error) => error.message }));

const take: VoiceoverTake = {
  uri: 'file:///capture.caf',
  startMs: 3534,
  endMs: 5534,
  sourceStartMs: 15,
  durationMs: 2020,
  pressToPlaybackMs: 4,
  pressToCaptureMs: 2,
  stopAlignmentMs: 0,
  audioVideoOffsetMs: 0,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function drain() {
  for (let turn = 0; turn < 16; turn++) await Promise.resolve();
}
function controller(position: number) {
  const ctl = {
    lastMs: position,
    totalMs: 30000,
    getPlayheadMs: jest.fn<() => number>((): number => ctl.lastMs),
    dragging: false,
    inflight: false,
    pending: null,
    afterBuild: null,
    pause: jest.fn(),
    endTrim: jest.fn<(ms: number) => void>((ms) => {
      ctl.lastMs = ms;
    }),
    seekTo: jest.fn<(ms: number) => void>((ms) => {
      ctl.lastMs = ms;
    }),
    waitUntilSettled: jest.fn(async () => true),
    ref: {
      prepareVoiceover: jest.fn(async () => {}),
      startVoiceover: jest.fn(async () => 3500),
      stopVoiceover: jest.fn(async () => take),
      cancelVoiceover: jest.fn(),
    },
  };
  return ctl;
}
function render(ctl: ReturnType<typeof controller>) {
  mockSlot = 0;
  mockEffects = [];
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Controlled hook harness without a native renderer.
  return useVoiceover('draft', ctl as unknown as PreviewTransport['ctl'], true, true);
}
async function mount(ctl: ReturnType<typeof controller>) {
  render(ctl);
  const dispose = mockEffects[0]();
  if (typeof dispose === 'function') cleanup = dispose;
  await drain();
  return render(ctl);
}
beforeEach(() => {
  mockSlots = [];
  jest.clearAllMocks();
  jest.spyOn(console, 'info').mockImplementation(() => {});
  mockAddTake.mockResolvedValue(undefined);
  mockUndoTake.mockResolvedValue(null);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  jest.restoreAllMocks();
});

it.each([0, 3512.375])(
  'saves the visible Record position %s separately from native playback and sample positions',
  async (position) => {
    const ctl = controller(position);
    const voiceover = await mount(ctl);
    voiceover.press();
    // Playback and later seeking must not replace the position captured by the press.
    ctl.lastMs = 5000;
    voiceover.release();
    await drain();

    expect(mockAddTake).toHaveBeenCalledWith({
      draftId: 'draft',
      cacheUri: take.uri,
      startMs: take.startMs,
      recordStartMs: position,
      durationMs: take.durationMs,
      trimStartMs: take.sourceStartMs,
      trimEndMs: 2015,
    });
    expect(ctl.endTrim).toHaveBeenCalledWith(take.endMs);
    expect(render(ctl).phase).toBe('ready');
  },
);

it('waits for a released take to save before Undo seeks its stored Record position', async () => {
  const position = 3512.375;
  const ctl = controller(position);
  const saved = deferred<void>();
  mockAddTake.mockImplementationOnce(() => saved.promise);
  mockUndoTake.mockResolvedValueOnce({ playheadMs: position });
  let voiceover = await mount(ctl);
  voiceover.press();
  voiceover.release();
  await drain();
  voiceover = render(ctl);
  expect(voiceover.phase).toBe('saving');
  voiceover.undo();
  await drain();
  expect(mockUndoTake).not.toHaveBeenCalled();
  expect(ctl.seekTo).not.toHaveBeenCalled();

  saved.resolve();
  await drain();
  expect(mockUndoTake).toHaveBeenCalledWith('draft');
  expect(ctl.seekTo).toHaveBeenCalledWith(position);
  expect(ctl.lastMs).toBe(position);
  expect(ctl.waitUntilSettled).toHaveBeenCalledTimes(2);
  expect(render(ctl).undoBusy).toBe(false);
});

it('retries a failed durable save using the original Record position after the playhead moves', async () => {
  const position = 3512.375;
  const ctl = controller(position);
  mockAddTake.mockRejectedValueOnce(new Error('disk full'));
  let voiceover = await mount(ctl);
  voiceover.press();
  voiceover.release();
  await drain();
  voiceover = render(ctl);
  expect(voiceover.phase).toBe('failed');
  ctl.lastMs = 12000;
  voiceover.retry();
  await drain();

  expect(mockAddTake).toHaveBeenCalledTimes(2);
  expect(mockAddTake.mock.calls[0][0].recordStartMs).toBe(position);
  expect(mockAddTake.mock.calls[1]).toEqual(mockAddTake.mock.calls[0]);
  expect(ctl.ref.startVoiceover).toHaveBeenCalledTimes(1);
  expect(render(ctl).phase).toBe('ready');
});

it('snapshots the displayed playback position even when the last native progress report is older', async () => {
  const ctl = controller(3400);
  const displayedPosition = 3478.25;
  ctl.getPlayheadMs.mockReturnValueOnce(displayedPosition);
  const voiceover = await mount(ctl);
  voiceover.press();
  ctl.lastMs = 5000;
  voiceover.release();
  await drain();

  expect(ctl.getPlayheadMs).toHaveBeenCalledTimes(1);
  expect(mockAddTake).toHaveBeenCalledWith(
    expect.objectContaining({ recordStartMs: displayedPosition, startMs: take.startMs }),
  );
});
