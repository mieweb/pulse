import { thumbnail } from '@mieweb/pulse-editor';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useSyncExternalStore } from 'react';

import type { ClipCrop } from '@/utils/segment-window';

// The editor's filmstrip: frames of a file at fixed source times, so a trim, a speed change or a
// reorder only shows more or less of frames already there, and a pinch reuses them. Frames sit on
// a grid of multiples of STEP_MS × 2^k; the scale picks the step that keeps them CELL_DP apart, and
// a coarser step's frames are all on the finer grids. A file's whole source gets the COARSE_MS
// frames (a handful per clip) and the part near the screen the scale's step: fetched near the
// screen first, then the coarse ones, two at a time. A frame not here yet shows the nearest
// coarser one that is, else the clip's cover, so nothing is ever blank. Frames are kept as files
// in the caches folder (the OS may clear it; they're fetched again), keyed by file, look and time.

/** The finest step between frames, source ms. */
const STEP_MS = 250;
/** Every clip's whole source gets frames this far apart (source ms), before any detail. */
const COARSE_MS = 4000;
/** The narrowest a frame is drawn, dp (a step is at most twice this). */
export const CELL_DP = 30;
const CONCURRENT = 2;
/** Frames that landed are shown together, at most this often. */
const NOTIFY_MS = 100;

/** How a clip's picture is drawn: as its edit has it (editor quarter turns, counter-clockwise). */
export type FrameLook = { rotation: number; flipped: boolean; crop: ClipCrop | null };

const lookKey = (l: FrameLook) =>
  `${l.rotation}${l.flipped ? 'f' : ''}${l.crop ? JSON.stringify(l.crop) : ''}`;
const frameKey = (uri: string, look: string, t: number) => `${uri}|${look}|${t}`;

// Frames fetched (key → file URI) or failed, those being fetched, and what each tile wants.
const frames = new Map<string, string>();
const failed = new Set<string>();
const inFlight = new Set<string>();
type Want = { uri: string; look: FrameLook; lookId: string; near: number[]; coarse: number[] };
const wanted = new Map<string, Want>();
let running = 0;

// Per file, a number that changes when its frames do (what a tile re-renders on).
const versions = new Map<string, number>();
const listeners = new Set<() => void>();
const landed = new Set<string>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function changed(uri: string) {
  landed.add(uri);
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const u of landed) versions.set(u, (versions.get(u) ?? 0) + 1);
    landed.clear();
    for (const l of listeners) l();
  }, NOTIFY_MS);
}

const cacheDir = () => new Directory(Paths.cache, 'filmstrip');

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** The step between frames (source ms) at `dpPerMs` for a clip at `speed`. */
export function frameStep(dpPerMs: number, speed: number): number {
  const need = (CELL_DP / dpPerMs) * speed;
  let step = STEP_MS;
  while (step < need) step *= 2;
  return step;
}

/** Source times on `step`'s grid from `fromMs` up to `toMs` (exclusive) and the source's end. */
export function frameTimes(step: number, fromMs: number, toMs: number, sourceMs: number): number[] {
  const out: number[] = [];
  const end = Math.min(toMs, sourceMs);
  for (let t = Math.max(0, Math.floor(fromMs / step) * step); t < end; t += step) out.push(t);
  return out;
}

/** The frame to show for time `t` on `step`'s grid: its own, else the nearest coarser one here. */
export function frameAt(uri: string, look: FrameLook, t: number, step: number): string | null {
  const id = lookKey(look);
  for (let s = step; s <= COARSE_MS * 64; s *= 2) {
    const f = frames.get(frameKey(uri, id, Math.floor(t / s) * s));
    if (f) return f;
  }
  return null;
}

/** The next frame to fetch: one wanted near the screen, else a coarse one. Disk hits on the way
 * are taken as they are (no fetch). */
function next(): { key: string; uri: string; look: FrameLook; t: number; file: File } | null {
  for (const pass of ['near', 'coarse'] as const) {
    for (const w of wanted.values()) {
      for (const t of w[pass]) {
        const key = frameKey(w.uri, w.lookId, t);
        if (frames.has(key) || failed.has(key) || inFlight.has(key)) continue;
        const file = new File(cacheDir(), `${hash(key)}.jpg`);
        if (file.exists) {
          frames.set(key, file.uri);
          changed(w.uri);
          continue;
        }
        return { key, uri: w.uri, look: w.look, t, file };
      }
    }
  }
  return null;
}

function pump() {
  while (running < CONCURRENT) {
    const job = next();
    if (!job) return;
    running++;
    inFlight.add(job.key);
    void fetchFrame(job).finally(() => {
      running--;
      inFlight.delete(job.key);
      pump();
    });
  }
}

async function fetchFrame(job: { key: string; uri: string; look: FrameLook; t: number; file: File }) {
  try {
    const shot = await thumbnail(job.uri, {
      timeMs: job.t,
      maxWidth: 120,
      maxHeight: 214,
      quality: 0.6,
      // The editor keeps counter-clockwise quarter turns; pulse-editor takes clockwise degrees.
      rotation: ((4 - job.look.rotation) % 4) * 90,
      flipped: job.look.flipped,
      crop: job.look.crop ?? undefined,
    });
    const dir = cacheDir();
    if (!dir.exists) dir.create({ intermediates: true });
    if (job.file.exists) job.file.delete();
    await new File(shot.uri).move(job.file);
    frames.set(job.key, job.file.uri);
  } catch {
    // Not fetched again this session; the cell keeps the coarser frame or the cover.
    failed.add(job.key);
  }
  changed(job.uri);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * A tile's frames: asks for `near` (the times it draws, near the screen) and the whole source's
 * coarse frames, for as long as it's mounted or until it asks for others. Returns a number that
 * changes when the file's frames do, to re-render on.
 */
export function useFrames(
  tileId: string,
  uri: string,
  look: FrameLook,
  near: readonly number[],
  sourceMs: number,
): number {
  const lookId = lookKey(look);
  const nearKey = near.join(',');
  useEffect(() => {
    wanted.set(tileId, {
      uri,
      look,
      lookId,
      near: nearKey ? nearKey.split(',').map(Number) : [],
      coarse: frameTimes(COARSE_MS, 0, sourceMs, sourceMs),
    });
    pump();
    // `look` is read for the fetch; `lookId` is what decides to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tileId, uri, lookId, nearKey, sourceMs]);
  useEffect(
    () => () => {
      wanted.delete(tileId);
    },
    [tileId],
  );
  return useSyncExternalStore(
    subscribe,
    () => versions.get(uri) ?? 0,
    () => versions.get(uri) ?? 0,
  );
}
