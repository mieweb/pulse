import { frames as grabFrames } from '@mieweb/pulse-editor';
import { Skia, type SkImage } from '@shopify/react-native-skia';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useSyncExternalStore } from 'react';
import { PixelRatio } from 'react-native';

import type { ClipCrop } from '@/utils/segment-window';

import { FILM_HEIGHT } from './clip-tile';

// The editor's filmstrip: frames of a file at fixed source times, so a trim, a speed change or a
// reorder only shows more or less of frames already there, and a pinch reuses them. Frames sit on
// a grid of multiples of STEP_MS × 2^k; the scale picks the coarsest step that still gives every
// tile (FILM_HEIGHT tall, the clip's picture's shape) a frame near its middle, and a coarser
// step's frames are all on the finer grids. A file's whole source gets the COARSE_MS
// frames (a handful per clip) and the part near the screen the scale's step: fetched near the
// screen first, then the coarse ones, a batch per file from one decoder (pulse-editor `frames`),
// each the nearest keyframe within half a step. Frames are decoded into GPU images the timeline
// canvas draws; one not here yet shows the nearest earlier one, else the clip's cover, so nothing
// is ever blank. The JPEGs are kept in the caches folder (the OS may clear it; they're fetched
// again), keyed by file, look and time; at most MAX_IMAGES are kept decoded.

/** The finest step between frames, source ms: 1000 / 32, about a frame at 30 fps, for the deepest
 * zoom (a tile there is under 80 ms). Exact in binary, so the grid's times add up without drift,
 * and every coarser step (250, 2000, …) is on it. */
const STEP_MS = 31.25;
/** Every clip's whole source gets frames this far apart (source ms), before any detail. */
const COARSE_MS = 2000;
/** Frames per call to the decoder, and calls running at once. */
const BATCH = 12;
const CONCURRENT = 2;
/** Frames that landed are shown together, at most this often. */
const NOTIFY_MS = 100;
/** Decoded frames kept in memory (about 140 KB each at the size asked for). */
const MAX_IMAGES = 400;
/** Frames come fitted inside a FRAME_BOX square (px): enough for a 16:9 tile (or a 9:16 one)
 * FILM_HEIGHT tall at the screen's density, so the whole frame is drawn sharp. */
const FRAME_BOX = Math.ceil((FILM_HEIGHT * PixelRatio.get() * 16) / 9);

/** How a clip's picture is drawn: as its edit has it (editor quarter turns, counter-clockwise). */
export type FrameLook = { rotation: number; flipped: boolean; crop: ClipCrop | null };

export const lookKey = (l: FrameLook) =>
  `${l.rotation}${l.flipped ? 'f' : ''}${l.crop ? JSON.stringify(l.crop) : ''}`;
const fileKey = (uri: string, look: string) => `${uri}|${look}`;

// Per file and look: its decoded frames by source time (insertion order = least recently used
// first, across all files via `lru`), the times failed or being fetched.
type Store = {
  uri: string;
  look: FrameLook;
  /** By the time asked for: the image, and the time it actually shows (ms). */
  images: Map<number, { image: SkImage; at: number }>;
  failed: Set<number>;
};
const stores = new Map<string, Store>();
const lru = new Map<string, { key: string; t: number }>();
const inFlight = new Set<string>();
type Want = { key: string; near: number[]; nearStep: number; coarse: number[] };
const wanted = new Map<string, Want>();
let running = 0;

/** Spike: what the store has done, read from the debugger. */
export const filmstripStats = {
  batches: [] as { file: string; n: number; ms: number; tolerance: number }[],
  failed: 0,
  diskHits: 0,
};

// Per file and look, a number that changes when its frames do (what the strip re-renders on).
let version = 0;
const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function changed() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    version++;
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

const cacheFile = (key: string, t: number) =>
  new File(cacheDir(), `${hash(`${key}|${t}|${FRAME_BOX}`)}.jpg`);

function storeFor(uri: string, look: FrameLook): Store {
  const key = fileKey(uri, lookKey(look));
  let s = stores.get(key);
  if (!s) {
    s = { uri, look, images: new Map(), failed: new Set() };
    stores.set(key, s);
  }
  return s;
}

function keep(key: string, store: Store, t: number, image: SkImage, at: number) {
  store.images.set(t, { image, at });
  const id = `${key}|${t}`;
  lru.delete(id);
  lru.set(id, { key, t });
  while (lru.size > MAX_IMAGES) {
    const [oldest, v] = lru.entries().next().value as [string, { key: string; t: number }];
    lru.delete(oldest);
    // Dropped, not disposed: the canvas may still draw it until its next update; it's freed once
    // nothing holds it.
    stores.get(v.key)?.images.delete(v.t);
  }
}

function decode(bytes: Uint8Array): SkImage | null {
  const data = Skia.Data.fromBytes(bytes);
  return Skia.Image.MakeImageFromEncoded(data);
}

/** The narrowest and widest a tile is, as a multiple of its height (a picture past these is drawn
 * by its middle). */
const MIN_ASPECT = 0.4;
const MAX_ASPECT = 2.5;

/**
 * A clip's filmstrip tile width (dp): FILM_HEIGHT tall in the shape of its picture as edited, so a
 * tile shows the whole picture. From one of its frames (with the edit's quarter turns and crop),
 * else its cover (drawn with the edit), else square.
 */
export function tileWidth(
  frame: SkImage | null,
  cover: SkImage | null,
  edit: { rotation: number; crop: ClipCrop | null },
): number {
  let aspect = 1;
  if (frame) {
    const turned = edit.rotation % 2 === 1;
    const w = (turned ? frame.height() : frame.width()) * (edit.crop?.w ?? 1);
    const h = (turned ? frame.width() : frame.height()) * (edit.crop?.h ?? 1);
    if (w > 0 && h > 0) aspect = w / h;
  } else if (cover && cover.height() > 0) aspect = cover.width() / cover.height();
  return FILM_HEIGHT * Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));
}

/** The step between frames (source ms) at `dpPerMs` for a clip at `speed` whose tiles are
 * `tileDp` wide: the coarsest on the grid that's no longer than a tile's time, so each tile has a
 * frame within half a step of its middle. */
export function frameStep(dpPerMs: number, speed: number, tileDp: number): number {
  const tileMs = (tileDp / dpPerMs) * speed;
  let step = STEP_MS;
  while (step * 2 <= tileMs) step *= 2;
  return step;
}

/** Source times on `step`'s grid from `fromMs` up to `toMs` (exclusive) and the source's end. */
export function frameTimes(step: number, fromMs: number, toMs: number, sourceMs: number): number[] {
  const out: number[] = [];
  const end = Math.min(toMs, sourceMs);
  for (let t = Math.max(0, Math.floor(fromMs / step) * step); t < end; t += step) out.push(t);
  return out;
}

/** Any one of a file's decoded frames (for its size), or null. */
export function anyFrame(uri: string, look: FrameLook): SkImage | null {
  const s = stores.get(fileKey(uri, lookKey(look)));
  return s?.images.values().next().value?.image ?? null;
}

/** A file's decoded frames by the time each shows (ascending, images beside them), for the
 * canvas, which draws each cell with the frame nearest its time. */
export function framesOf(uri: string, look: FrameLook): { times: number[]; images: SkImage[] } {
  const s = stores.get(fileKey(uri, lookKey(look)));
  if (!s) return { times: [], images: [] };
  const all = [...s.images.values()].sort((a, b) => a.at - b.at);
  return { times: all.map((f) => f.at), images: all.map((f) => f.image) };
}

/** The next batch: one file's frames still wanted, near the screen first, then coarse ones, its
 * file claimed (in `inFlight`) until the batch is done. A frame on disk is decoded on the way
 * instead of fetched. */
async function nextBatch(): Promise<{
  store: Store;
  key: string;
  times: number[];
  step: number;
} | null> {
  for (const pass of ['near', 'coarse'] as const) {
    for (const w of [...wanted.values()]) {
      const store = stores.get(w.key);
      if (!store || inFlight.has(w.key)) continue;
      inFlight.add(w.key);
      const times: number[] = [];
      for (const t of w[pass]) {
        if (store.images.has(t) || store.failed.has(t)) continue;
        const file = cacheFile(w.key, t);
        if (file.exists) {
          try {
            const img = decode(await file.bytes());
            if (img) {
              keep(w.key, store, t, img, t);
              filmstripStats.diskHits++;
              changed();
              continue;
            }
          } catch {
            // Fetched again below.
          }
        }
        times.push(t);
        if (times.length >= BATCH) break;
      }
      if (times.length)
        return { store, key: w.key, times, step: pass === 'near' ? w.nearStep : COARSE_MS };
      inFlight.delete(w.key);
    }
  }
  return null;
}

/** Start workers up to CONCURRENT; each takes batches until there's nothing left to fetch. */
function pump() {
  while (running < CONCURRENT) {
    running++;
    void work().finally(() => {
      running--;
    });
  }
}

async function work() {
  for (;;) {
    const batch = await nextBatch();
    if (!batch) return;
    try {
      await fetchBatch(batch);
    } finally {
      inFlight.delete(batch.key);
    }
  }
}

async function fetchBatch(batch: { store: Store; key: string; times: number[]; step: number }) {
  const { store, key, times, step } = batch;
  const began = Date.now();
  try {
    const got = await grabFrames(store.uri, {
      timesMs: times,
      maxWidth: FRAME_BOX,
      maxHeight: FRAME_BOX,
      quality: 0.6,
      toleranceMs: step / 2,
      // The editor keeps counter-clockwise quarter turns; pulse-editor takes clockwise degrees.
      rotation: ((4 - store.look.rotation) % 4) * 90,
      flipped: store.look.flipped,
      crop: store.look.crop ?? undefined,
    });
    filmstripStats.batches.push({
      file: store.uri.split('/').pop() ?? '',
      n: got.length,
      ms: Date.now() - began,
      tolerance: step / 2,
    });
    const dir = cacheDir();
    if (!dir.exists) dir.create({ intermediates: true });
    for (const f of got) {
      const bytes = new Uint8Array(f.data);
      const img = decode(bytes);
      if (!img) {
        store.failed.add(f.timeMs);
        continue;
      }
      keep(key, store, f.timeMs, img, f.actualMs);
      try {
        const file = cacheFile(key, f.timeMs);
        file.create({ overwrite: true });
        file.write(bytes);
      } catch {
        // Not cached on disk: fetched again next time.
      }
    }
  } catch {
    // Not fetched again this session; the cells keep the earlier frame or the cover.
    for (const t of times) store.failed.add(t);
    filmstripStats.failed += times.length;
  }
  changed();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What a clip asks for: its file and look, the times near the screen (at `nearStep`), and its
 * source length (for the coarse frames). */
export type FrameWant = {
  id: string;
  uri: string;
  look: FrameLook;
  near: readonly number[];
  nearStep: number;
  sourceMs: number;
};

/**
 * The strip's frames: asks for each clip's near and coarse frames for as long as it's mounted or
 * until it asks for others. Returns a number that changes when any frames land (throttled), to
 * re-read `framesOf` on.
 */
export function useFrames(wants: readonly FrameWant[]): number {
  const signature = wants
    .map(
      (w) => `${w.id}:${w.uri}:${lookKey(w.look)}:${w.nearStep}:${w.near.join(',')}:${w.sourceMs}`,
    )
    .join('\n');
  useEffect(() => {
    // In the order given (nearest the playhead first): the order batches are taken in.
    wanted.clear();
    for (const w of wants) {
      const store = storeFor(w.uri, w.look);
      const key = fileKey(store.uri, lookKey(store.look));
      wanted.set(w.id, {
        key,
        near: [...w.near],
        nearStep: w.nearStep,
        coarse: frameTimes(COARSE_MS, 0, w.sourceMs, w.sourceMs),
      });
    }
    pump();
    // `wants` is read for the request; `signature` is what decides to ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  useEffect(
    () => () => {
      wanted.clear();
    },
    [],
  );
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}
