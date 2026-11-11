import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { DraftContext } from '@/db/drafts';
import {
  offerRecorderPlace,
  peekRecorderPlace,
  type RecorderPlace,
  takeRecorderPlace,
  withdrawRecorderPlace,
} from '@/features/recorder/link-place';

import {
  createRecorderOpener,
  HANDOFF_MS,
  type OpenRecorderDeps,
  type RecorderTarget,
  SAVE_TIMEOUT_MS,
  showRecorder,
} from './open-recorder';

const SERVER = 'https://vault.example.org/pulsevault';
// A key the router's own encoding would not hand back as it was: `%2F` decodes to `/`.
const REF = 'ticket%3A12:a/b%2Fc';

/** The recorder just pushed mounts and takes the place on offer, as `recorder.tsx` does. */
function mountRecorder(): RecorderPlace | null {
  const place = peekRecorderPlace();
  if (place) takeRecorderPlace(place);
  return place;
}

function harness(over: Partial<OpenRecorderDeps> = {}) {
  const calls: string[] = [];
  const pushed: (string | null)[] = [];
  const mounted: (RecorderPlace | null)[] = [];
  const deps: OpenRecorderDeps = {
    sheetGone: async () => void calls.push('sheet-gone'),
    finalizeRecorders: async () => void calls.push('finalize'),
    flushDraftWrites: async () => void calls.push('flush'),
    findOpenDraft: async () => {
      calls.push('find');
      return null;
    },
    recorderOnScreen: () => null,
    canDismiss: () => false,
    dismissAll: () => void calls.push('dismiss'),
    recordersGone: async () => void calls.push('recorders-gone'),
    offerPlace: (place) => {
      calls.push('offer');
      offerRecorderPlace(place, Date.now() + 5000);
    },
    push: (draftId) => {
      calls.push('push');
      pushed.push(draftId);
      mounted.push(mountRecorder());
    },
    ...over,
  };
  const opened: (string | null)[] = [];
  let failed = 0;
  const target = (ref = REF): RecorderTarget => ({
    server: SERVER,
    ref,
    name: 'Huddle update',
    opened: (draftId) => void opened.push(draftId),
    failed: () => void failed++,
  });
  return { deps, calls, pushed, mounted, opened, target, failures: () => failed };
}

beforeEach(() => withdrawRecorderPlace());

describe('showRecorder', () => {
  it('saves the take in progress and pending edits before it looks for the place’s draft', async () => {
    const h = harness({ canDismiss: () => true });
    await showRecorder(h.target(), h.deps);
    expect(h.calls).toEqual([
      'sheet-gone',
      'finalize',
      'flush',
      'find',
      'dismiss',
      'recorders-gone',
      'offer',
      'push',
    ]);
    expect(h.opened).toEqual([null]);
  });

  it('opens on the place’s open draft when it has one', async () => {
    const asked: DraftContext[] = [];
    const h = harness({
      findOpenDraft: async (context) => {
        asked.push(context);
        return 'draft-7';
      },
    });
    await showRecorder(h.target(), h.deps);
    expect(asked).toEqual([{ server: SERVER, ref: REF }]);
    expect(h.pushed).toEqual(['draft-7']);
    expect(h.opened).toEqual(['draft-7']);
  });

  it('pushes over Home without dismissing anything', async () => {
    const h = harness();
    await showRecorder(h.target(), h.deps);
    expect(h.calls).not.toContain('dismiss');
    expect(h.calls).not.toContain('recorders-gone');
    expect(h.pushed).toEqual([null]);
  });

  it('hands the place to the recorder in memory, exactly as the token gave it', async () => {
    const h = harness();
    await showRecorder(h.target(), h.deps);
    // Nothing of the place is in what is pushed: only the draft to open on.
    expect(h.pushed).toEqual([null]);
    // What the recorder that mounts reads: the `%`, `:` and `/` all as they were.
    const [place] = h.mounted;
    expect(place).toMatchObject({ context: { server: SERVER, ref: REF }, name: 'Huddle update' });
    expect(place?.context.ref).toBe('ticket%3A12:a/b%2Fc');
    expect(peekRecorderPlace()).toBeNull();
  });

  it('leaves the recorder alone when it is already on the place’s draft', async () => {
    const h = harness({
      canDismiss: () => true,
      findOpenDraft: async () => 'draft-7',
      recorderOnScreen: () => ({ place: null, draftId: 'draft-7' }),
    });
    await showRecorder(h.target(), h.deps);
    expect(h.calls).toEqual(['sheet-gone', 'finalize', 'flush']);
    expect(h.opened).toEqual(['draft-7']);
    expect(peekRecorderPlace()).toBeNull();
  });

  it('leaves the recorder alone when it was opened for the place and has recorded nothing yet', async () => {
    const h = harness({
      canDismiss: () => true,
      recorderOnScreen: () => ({ place: { server: SERVER, ref: REF }, draftId: null }),
    });
    await showRecorder(h.target(), h.deps);
    expect(h.calls).not.toContain('push');
    expect(h.opened).toEqual([null]);
  });

  it('replaces a recorder that is on another draft or for another place', async () => {
    for (const onScreen of [
      { place: null, draftId: 'other-draft' },
      { place: { server: SERVER, ref: 'another-place' }, draftId: null },
      { place: { server: 'https://other.example.org', ref: REF }, draftId: null },
      // A new recording from Home, for no place.
      { place: null, draftId: null },
      // On the place's draft, but the place has a newer open draft to go to.
      { place: { server: SERVER, ref: REF }, draftId: 'older-draft' },
    ]) {
      const h = harness({
        canDismiss: () => true,
        findOpenDraft: async () => (onScreen.draftId === 'older-draft' ? 'newer-draft' : null),
        recorderOnScreen: () => onScreen,
      });
      await showRecorder(h.target(), h.deps);
      expect(h.calls.slice(-4)).toEqual(['dismiss', 'recorders-gone', 'offer', 'push']);
    }
  });
});

describe('createRecorderOpener', () => {
  it('opens one link’s recorder at a time, in the order the links came', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const first = new Promise<void>((resolve) => (release = resolve));
    let finds = 0;
    const h = harness({
      findOpenDraft: async (context) => {
        order.push(`find:${context.ref}`);
        if (finds++ === 0) await first;
        return null;
      },
      push: () => {
        order.push('push');
        mountRecorder();
      },
    });
    const open = createRecorderOpener(h.deps);
    open(h.target('place-a'));
    open(h.target('place-b'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['find:place-a']);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['find:place-a', 'push', 'find:place-b', 'push']);
    expect(h.opened).toEqual([null, null]);
  });

  it('tells the link when its recorder couldn’t be opened, and still opens the next', async () => {
    let broken = true;
    const h = harness({
      findOpenDraft: async () => {
        if (broken) throw new Error('db closed');
        return null;
      },
    });
    const open = createRecorderOpener(h.deps);
    open(h.target());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.failures()).toBe(1);
    expect(h.opened).toEqual([]);
    expect(h.pushed).toEqual([]);

    broken = false;
    open(h.target());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.failures()).toBe(1);
    expect(h.pushed).toEqual([null]);
  });

  it('opens the next link’s recorder only once the last one has taken its place', async () => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    // The recorders mount when the test says, not as they are pushed.
    const h = harness({ push: (draftId) => void h.pushed.push(draftId) });
    const open = createRecorderOpener(h.deps);
    open(h.target('place-a'));
    open(h.target('place-b'));
    await tick();

    // The first recorder hasn't mounted: its place is still on offer, and the second link waits.
    expect(h.calls.filter((c) => c === 'offer')).toHaveLength(1);
    expect(h.opened).toEqual([]);
    expect(mountRecorder()?.context.ref).toBe('place-a');
    await tick();

    expect(h.opened).toEqual([null]);
    expect(h.calls.filter((c) => c === 'offer')).toHaveLength(2);
    expect(mountRecorder()?.context.ref).toBe('place-b');
    await tick();
    expect(h.opened).toEqual([null, null]);
  });

  describe('when a recorder never takes its place', () => {
    beforeEach(() => void jest.useFakeTimers());
    afterEach(() => void jest.useRealTimers());

    it('still opens the next link’s recorder once the place’s offer has lapsed', async () => {
      const h = harness({ push: (draftId) => void h.pushed.push(draftId) });
      const open = createRecorderOpener(h.deps);
      open(h.target('never-taken'));
      open(h.target('next'));
      await jest.advanceTimersByTimeAsync(HANDOFF_MS - 1);
      expect(h.pushed).toEqual([null]);

      await jest.advanceTimersByTimeAsync(1);
      expect(h.pushed).toEqual([null, null]);
      expect(peekRecorderPlace()?.context.ref).toBe('next');
    });
  });

  describe('when a take never finishes saving', () => {
    beforeEach(() => void jest.useFakeTimers());
    afterEach(() => void jest.useRealTimers());

    it('gives up on that link, touches nothing on screen, and still opens the next', async () => {
      let stuck = true;
      const h = harness({
        canDismiss: () => true,
        finalizeRecorders: () => (stuck ? new Promise(() => {}) : Promise.resolve()),
      });
      const open = createRecorderOpener(h.deps);
      open(h.target('first'));
      await jest.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS - 1);
      expect(h.failures()).toBe(0);
      await jest.advanceTimersByTimeAsync(1);
      expect(h.failures()).toBe(1);
      // The recorder whose take is unsaved is not dismissed, and no second one is pushed.
      expect(h.calls).not.toContain('dismiss');
      expect(h.pushed).toEqual([]);

      stuck = false;
      open(h.target('second'));
      await jest.advanceTimersByTimeAsync(0);
      expect(h.pushed).toEqual([null]);
      expect(h.opened).toEqual([null]);
    });
  });
});
