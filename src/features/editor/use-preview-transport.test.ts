import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PreviewStatus, PulsePreviewRef } from '@mieweb/pulse-editor';

// Exercise the hook's real controller with controlled native completions. React rendering,
// worklet frames and the audio/device lifecycle aren't needed to reproduce seek ordering.
jest.mock('react', () => ({
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}));
jest.mock('react-native-reanimated', () => ({
  useSharedValue: (initial: unknown) => {
    let value = initial;
    return {
      get: () => value,
      set: (next: unknown) => {
        value = next;
      },
    };
  },
  useFrameCallback: () => {},
}));
jest.mock('react-native', () => ({ AppState: {} }));
jest.mock('react-native-worklets', () => ({ scheduleOnRN: () => {} }));
jest.mock('expo-audio', () => ({ setAudioModeAsync: async () => {} }));
jest.mock('@/utils/audio-session', () => ({ claimAudioSession: () => {} }));

/* eslint-disable import/first -- controller imports follow native stand-ins */
import { usePreviewTransport } from './use-preview-transport';
/* eslint-enable import/first */

function gate() {
  let resolve!: (ms: number) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<number>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const ready = (durationMs: number): PreviewStatus => ({
  durationMs,
  clipStartsMs: [0],
  ready: true,
});
const drain = async () => {
  // Let the native promise's success/error handler and queued-seek continuation both run.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
function preview(...landings: ReturnType<typeof gate>[]) {
  const seek = jest.fn<(ms: number) => Promise<number>>();
  for (const landing of landings) seek.mockImplementationOnce(() => landing.promise);
  seek.mockImplementation(async (ms) => ms);
  const ref: PulsePreviewRef = {
    name: 'PulsePreview',
    equals: () => false,
    dispose: () => {},
    clips: [],
    options: {
      width: 1080,
      height: 1920,
      fps: 30,
      bitrate: 5000000,
      audio: { sampleRate: 48000, channels: 2 },
    },
    onTime: () => {},
    onStatus: () => {},
    seek,
    play: jest.fn(),
    pause: jest.fn(),
    setScrubbing: jest.fn(),
    snapshot: async () => '',
    stats: () => ({
      firstFrameMs: -1,
      lastSeekMs: -1,
      lastSwapMs: -1,
      framesShown: 0,
      framesDropped: 0,
    }),
  };
  return { ref, seek };
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('preview initial placement', () => {
  it('cannot replay the opening position over an append queued during its first seek', async () => {
    const opening = gate();
    const append = gate();
    const native = preview(opening, append);
    const { ctl, values } = usePreviewTransport();
    ctl.setTotal(10000);
    ctl.place(9999);
    ctl.onReady(native.ref);
    ctl.onStatus(ready(10000));
    expect(native.seek.mock.calls).toEqual([[9999]]);

    ctl.setTotal(12000);
    ctl.seekTo(11999);
    expect(values.covered.get()).toBe(0);
    // iOS announces ready again for the rebuilt timeline while the opening seek is pending.
    ctl.onStatus(ready(12000));
    ctl.onStatus(ready(12000));
    expect(native.seek.mock.calls).toEqual([[9999]]);

    opening.resolve(9999);
    await drain();
    expect(native.seek.mock.calls).toEqual([[9999], [11999]]);
    expect(values.timeMs.get()).toBe(11999);
    append.resolve(11999);
    await drain();
    ctl.onTime(11960, false); // Frame rounding retains the exact insertion target.
    jest.advanceTimersByTime(1500);
    expect(values.timeMs.get()).toBe(11999);
    expect(native.seek).toHaveBeenCalledTimes(2);
  });

  it('uncovers once the initial seek lands and sends it only once across duplicate ready events', async () => {
    const opening = gate();
    const native = preview(opening);
    const { ctl, values } = usePreviewTransport();
    ctl.setTotal(10000);
    ctl.place(3000);
    ctl.onReady(native.ref);
    ctl.onStatus(ready(10000));
    ctl.onStatus(ready(10000));
    ctl.onTime(0, false);
    expect(values.covered.get()).toBe(1);
    expect(values.timeMs.get()).toBe(3000);
    expect(native.seek.mock.calls).toEqual([[3000]]);
    opening.resolve(3000);
    await drain();
    expect(values.covered.get()).toBe(0);
    expect(values.timeMs.get()).toBe(3000);
  });

  it('a newer seek cancels an opening placement that has not been dispatched', async () => {
    const append = gate();
    const native = preview(append);
    const { ctl, values } = usePreviewTransport();
    ctl.setTotal(10000);
    ctl.place(9999);
    ctl.onReady(native.ref);
    ctl.setTotal(12000);
    ctl.seekTo(11999);
    ctl.onStatus(ready(12000));
    expect(values.covered.get()).toBe(0);
    expect(native.seek.mock.calls).toEqual([[11999]]);
    append.resolve(11999);
    await drain();
    expect(values.timeMs.get()).toBe(11999);
  });

  it('old completions and timeouts cannot uncover or settle a newer placement', async () => {
    const old = gate();
    const current = gate();
    const native = preview(old, current);
    const { ctl, values } = usePreviewTransport();
    ctl.setTotal(10000);
    ctl.place(3000);
    ctl.onReady(native.ref);
    ctl.onStatus(ready(10000));
    ctl.place(8000);
    old.resolve(3000);
    await drain();
    jest.advanceTimersByTime(1500);
    expect(values.covered.get()).toBe(1);
    expect(values.timeMs.get()).toBe(8000);
    ctl.onStatus(ready(10000));
    current.resolve(8000);
    await drain();
    expect(values.covered.get()).toBe(0);
    expect(values.timeMs.get()).toBe(8000);
  });

  it('unblocks the preview when an initial seek fails or times out', async () => {
    const failure = gate();
    const native = preview(failure);
    const { ctl, values } = usePreviewTransport();
    ctl.place(3000);
    ctl.onReady(native.ref);
    ctl.onStatus(ready(10000));
    failure.reject(new Error('preview released'));
    await drain();
    expect(values.covered.get()).toBe(0);

    const unanswered = gate();
    ctl.place(4000);
    ctl.onReady(preview(unanswered).ref);
    ctl.onStatus(ready(10000));
    jest.advanceTimersByTime(1500);
    expect(values.covered.get()).toBe(0);
    unanswered.resolve(4000);
    await drain();
  });

  it('a detached preview cannot finish placement over its replacement', async () => {
    const old = gate();
    const current = gate();
    const { ctl, values } = usePreviewTransport();
    ctl.place(3000);
    ctl.onReady(preview(old).ref);
    ctl.onStatus(ready(10000));
    ctl.detach();
    expect(values.covered.get()).toBe(0);
    ctl.place(6000);
    ctl.onReady(preview(current).ref);
    ctl.onStatus(ready(10000));
    old.resolve(3000);
    await drain();
    expect(values.covered.get()).toBe(1);
    expect(values.timeMs.get()).toBe(6000);
    current.resolve(6000);
    await drain();
    expect(values.covered.get()).toBe(0);
    expect(values.timeMs.get()).toBe(6000);
  });
});
