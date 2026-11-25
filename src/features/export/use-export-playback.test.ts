import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { VideoPlayer } from 'expo-video';

// Drive the actual export and parked-playback hooks through renders and native events. The
// small harness keeps effect dependencies/cleanup; no video decoder or native renderer is used.
type Slot = { deps?: readonly unknown[]; cleanup?: () => void; phase: 'layout' | 'passive' };
let mockSlots: Slot[] = [];
let mockIndex = 0;
let mockEffects: (() => void)[] = [];
function mockEffect(
  phase: Slot['phase'],
  effect: () => void | (() => void),
  deps?: readonly unknown[],
) {
  const index = mockIndex++;
  const slot = mockSlots[index];
  if (
    slot &&
    deps &&
    deps.length === slot.deps?.length &&
    deps.every((value, i) => Object.is(value, slot.deps?.[i]))
  )
    return;
  mockEffects.push(() => {
    slot?.cleanup?.();
    mockSlots[index] = { deps, cleanup: effect() || undefined, phase };
  });
}
function mockUseEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
  mockEffect('passive', effect, deps);
}
function mockUseLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
  mockEffect('layout', effect, deps);
}
jest.mock('react', () => ({ useEffect: mockUseEffect, useLayoutEffect: mockUseLayoutEffect }));

type NativeEvent = { isPlaying?: boolean };
type Listener = (event: NativeEvent) => void;
type FakePlayer = ReturnType<typeof makePlayer>;
jest.mock('expo', () => ({
  useEvent: (player: FakePlayer) => ({ isPlaying: player.playing }),
  useEventListener: (player: FakePlayer, event: string, listener: Listener) =>
    mockUseEffect(() => player.addListener(event, listener).remove, [player, event, listener]),
}));
let mockFocused = true;
jest.mock('@/core/navigation/focus', () => ({ useScreenFocused: () => mockFocused }));
const mockAppListeners = new Set<(state: string) => void>();
const mockAppState = {
  currentState: 'active',
  addEventListener: (_event: string, listener: (state: string) => void) => {
    mockAppListeners.add(listener);
    return { remove: () => mockAppListeners.delete(listener) };
  },
};
jest.mock('react-native', () => ({
  get AppState() {
    return mockAppState;
  },
}));

/* eslint-disable import/first -- Native stand-ins above exercise both real hooks. */
import { useExportPlayback } from './use-export-playback';
/* eslint-enable import/first */

function makePlayer() {
  const listeners = new Map<string, Set<Listener>>();
  const player = {
    playing: false,
    currentTime: 0,
    released: false,
    play: jest.fn(() => {
      player.playing = true;
      player.emit('playingChange', { isPlaying: true });
    }),
    pause: jest.fn(() => {
      if (player.released) throw new Error('Native player has already been released');
      player.playing = false;
      player.emit('playingChange', { isPlaying: false });
    }),
    emit: (event: string, data: NativeEvent = {}) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(data);
    },
    addListener: (event: string, listener: Listener) => {
      const group = listeners.get(event) ?? new Set<Listener>();
      listeners.set(event, group);
      group.add(listener);
      return { remove: () => group.delete(listener) };
    },
    listenerCount: () => [...listeners.values()].reduce((sum, group) => sum + group.size, 0),
  };
  return player;
}
function render(player: FakePlayer, blocked = false) {
  mockIndex = 0;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Controlled hook harness.
  const result = useExportPlayback(player as unknown as VideoPlayer, blocked);
  for (const effect of mockEffects.splice(0)) effect();
  return result;
}
function appState(state: string) {
  mockAppState.currentState = state;
  for (const listener of [...mockAppListeners]) listener(state);
}
function unmount(releasePlayer?: () => void) {
  for (const slot of mockSlots.filter((slot) => slot.phase === 'layout')) slot.cleanup?.();
  // useVideoPlayer's earlier passive cleanup releases the handle before later passive effects.
  releasePlayer?.();
  for (const slot of mockSlots.filter((slot) => slot.phase === 'passive')) slot.cleanup?.();
  mockSlots = [];
}

beforeEach(() => {
  mockSlots = [];
  mockIndex = 0;
  mockEffects = [];
  mockFocused = true;
  mockAppState.currentState = 'active';
  mockAppListeners.clear();
});
afterEach(() => unmount());

describe('export preview playback', () => {
  it('opens paused and only plays or pauses on a manual toggle', () => {
    const player = makePlayer();
    player.playing = true; // A reused/native handle cannot carry playback into the preview.
    render(player);
    expect(player.playing).toBe(false);
    expect(player.play).not.toHaveBeenCalled();
    expect(render(player).isPlaying).toBe(false);

    render(player).togglePlay();
    expect(player.playing).toBe(true);
    expect(render(player).isPlaying).toBe(true);
    render(player).togglePlay();
    expect(player.playing).toBe(false);
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('stays paused when returning from another screen until Play is pressed', () => {
    const player = makePlayer();
    render(player).togglePlay();
    mockFocused = false;
    const blurred = render(player);
    expect(player.playing).toBe(false);
    blurred.togglePlay();
    player.play(); // Native controls must also respect an unfocused screen.
    expect(player.playing).toBe(false);

    mockFocused = true;
    const returned = render(player);
    expect(player.playing).toBe(false);
    expect(player.play).toHaveBeenCalledTimes(2);
    returned.togglePlay();
    expect(player.playing).toBe(true);
  });

  it.each(['inactive', 'background'])('stays paused after %s and foreground', (state) => {
    const player = makePlayer();
    const playback = render(player);
    playback.togglePlay();
    appState(state);
    expect(player.playing).toBe(false);
    playback.togglePlay();
    player.play(); // An external/native attempt cannot restart it in the background.
    expect(player.playing).toBe(false);

    appState('active');
    expect(player.playing).toBe(false);
    expect(player.play).toHaveBeenCalledTimes(2);
    playback.togglePlay();
    expect(player.playing).toBe(true);
  });

  it('pauses for a share/send sheet and waits for a manual play after it closes', () => {
    const player = makePlayer();
    render(player).togglePlay();
    const blocked = render(player, true);
    expect(player.playing).toBe(false);
    blocked.togglePlay();
    player.play();
    expect(player.playing).toBe(false);

    const returned = render(player, false);
    expect(player.playing).toBe(false);
    expect(player.play).toHaveBeenCalledTimes(2);
    returned.togglePlay();
    expect(player.playing).toBe(true);
  });

  it('starts a regenerated source paused and removes the previous lifecycle listeners', () => {
    const previous = makePlayer();
    render(previous).togglePlay();
    const regenerated = makePlayer();
    regenerated.playing = true;
    render(regenerated);
    expect(previous.playing).toBe(false);
    expect(previous.listenerCount()).toBe(0);
    expect(regenerated.playing).toBe(false);
    expect(regenerated.play).not.toHaveBeenCalled();
    expect(mockAppListeners.size).toBe(1);

    previous.pause.mockClear();
    render(regenerated).togglePlay();
    appState('background');
    expect(regenerated.playing).toBe(false);
    expect(previous.pause).not.toHaveBeenCalled();
  });

  it('parks silently at the start after completion and replays by manual Play', () => {
    const player = makePlayer();
    render(player).togglePlay();
    player.currentTime = 38;
    player.playing = false;
    player.emit('playToEnd');
    expect(player.currentTime).toBe(0);
    expect(player.playing).toBe(false);
    expect(player.play).toHaveBeenCalledTimes(1);

    render(player).togglePlay();
    expect(player.playing).toBe(true);
    expect(player.currentTime).toBe(0);
    expect(player.play).toHaveBeenCalledTimes(2);
  });

  it('pauses and removes all owned listeners when the preview unmounts', () => {
    const player = makePlayer();
    render(player).togglePlay();
    unmount();
    expect(player.playing).toBe(false);
    expect(player.listenerCount()).toBe(0);
    expect(mockAppListeners.size).toBe(0);
    player.pause.mockClear();
    appState('background');
    expect(player.pause).not.toHaveBeenCalled();
  });

  it('pauses before expo-video releases its native handle during passive cleanup', () => {
    const player = makePlayer();
    render(player).togglePlay();
    expect(() =>
      unmount(() => {
        player.released = true;
      }),
    ).not.toThrow();
    expect(player.playing).toBe(false);
    expect(player.released).toBe(true);
    expect(player.listenerCount()).toBe(0);
    expect(mockAppListeners.size).toBe(0);
    // The fake enforces the native contract, rather than silently accepting calls after release.
    expect(() => player.pause()).toThrow('Native player has already been released');
  });
});
