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
// step's frames are all on the finer grids. A file's whole source gets the COARSE_MS frames (a
// handful per clip) and the part near the screen the scale's step: fetched near the screen first,
// then the coarse ones, a batch per file from one decoder (pulse-editor `frames`), each the
// nearest keyframe within half a step. Frames are the file's own, upright and unedited (the canvas
// draws a clip's rotate, flip and crop on them), decoded into GPU images the timeline canvas
// draws; a tile whose frame isn't here yet shows the loaded frame nearest it, else the clip's
// cover, so nothing is ever blank. The JPEGs are kept in the caches folder, a folder per file,
// each named by the time asked for and the time it shows (the OS may clear it; they're fetched
// again); at most MAX_IMAGES are kept decoded, the ones near the screen kept first.

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

// Per file: its decoded frames by the time asked for (insertion order = least recently used first,
// across all files via `lru`), the times that failed, and what its disk folder holds (read once).
type Store = {
  uri: string;
  /** By the time asked for: the image, and the time it actually shows (ms). */
  images: Map<number, { image: SkImage; at: number }>;
  failed: Set<number>;
  /** By the time asked for: the cached JPEG and the time it shows; null until read. */
  disk: Map<number, { file: File; at: number }> | null;
};
const stores = new Map<string, Store>();
const lru = new Map<string, { uri: string; t: number }>();
const inFlight = new Set<string>();
type Want = { near: number[]; nearStep: number; coarse: number[] };
const wanted = new Map<string, Want>();
/** The frames near the screen (`uri|t`): kept decoded ahead of all others. */
let pinned = new Set<string>();
let running = 0;

// A number that changes when any file's frames do (what the strip re-renders on).
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

const cacheRoot = () => new Directory(Paths.cache, 'filmstrip');

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** A file's cache folder (its frames at this size). */
const folderName = (uri: string) => hash(`${uri}|${FRAME_BOX}`);
const folderOf = (uri: string) => new Directory(cacheRoot(), folderName(uri));

function storeFor(uri: string): Store {
  let s = stores.get(uri);
  if (!s) {
    s = { uri, images: new Map(), failed: new Set(), disk: null };
    stores.set(uri, s);
  }
  return s;
}

/** What a file's cache folder holds: `<asked>@<shows>.jpg` files. */
function readDisk(store: Store): Map<number, { file: File; at: number }> {
  if (store.disk) return store.disk;
  const disk = new Map<number, { file: File; at: number }>();
  try {
    const dir = folderOf(store.uri);
    if (dir.exists) {
      for (const f of dir.list()) {
        const m = f instanceof File ? /^([\d.]+)@([\d.]+)\.jpg$/.exec(f.name) : null;
        if (m && f instanceof File) disk.set(Number(m[1]), { file: f, at: Number(m[2]) });
      }
    }
  } catch {
    // Read as empty: the frames are fetched again.
  }
  store.disk = disk;
  return disk;
}

function keep(store: Store, t: number, image: SkImage, at: number) {
  store.images.set(t, { image, at });
  const id = `${store.uri}|${t}`;
  lru.delete(id);
  lru.set(id, { uri: store.uri, t });
  if (lru.size <= MAX_IMAGES) return;
  // The least recently used first, except frames near the screen (which may run over the limit
  // for as long as they're wanted). Dropped, not disposed: the canvas may still draw one until its
  // next update; it's freed once nothing holds it.
  for (const [k, v] of lru) {
    if (lru.size <= MAX_IMAGES) break;
    if (pinned.has(k)) continue;
    lru.delete(k);
    stores.get(v.uri)?.images.delete(v.t);
  }
}

function decode(bytes: Uint8Array): SkImage | null {
  const data = Skia.Data.fromBytes(bytes);
  return Skia.Image.MakeImageFromEncoded(data);
}

/**
 * The cache keeps only the files in `uris` (every clip's, in every draft), once per app run: a
 * deleted clip's frames go with it. Earlier caches (flat files) go too.
 */
let pruned = false;
export function pruneFrameCache(uris: readonly string[]) {
  if (pruned) return;
  pruned = true;
  try {
    const root = cacheRoot();
    if (!root.exists) return;
    const keepNames = new Set(uris.map(folderName));
    for (const entry of root.list()) {
      if (entry instanceof Directory && keepNames.has(entry.name)) continue;
      entry.delete();
    }
  } catch {
    // Tried again next run.
  }
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
export function anyFrame(uri: string): SkImage | null {
  return stores.get(uri)?.images.values().next().value?.image ?? null;
}

/** A file's decoded frames by the time each shows (ascending, images beside them), for the
 * canvas, which draws each tile with the frame nearest its time. */
export function framesOf(uri: string): { times: number[]; images: SkImage[] } {
  const s = stores.get(uri);
  if (!s) return { times: [], images: [] };
  const all = [...s.images.values()].sort((a, b) => a.at - b.at);
  return { times: all.map((f) => f.at), images: all.map((f) => f.image) };
}

/** The next batch: one file's frames still wanted, near the screen first, then coarse ones, its
 * file claimed (in `inFlight`) until the batch is done. A frame on disk is decoded on the way
 * instead of fetched. */
async function nextBatch(): Promise<{ store: Store; times: number[]; step: number } | null> {
  for (const pass of ['near', 'coarse'] as const) {
    for (const [uri, w] of [...wanted]) {
      const store = stores.get(uri);
      if (!store || inFlight.has(uri)) continue;
      inFlight.add(uri);
      const disk = readDisk(store);
      const times: number[] = [];
      for (const t of w[pass]) {
        if (store.images.has(t) || store.failed.has(t)) continue;
        const cached = disk.get(t);
        if (cached) {
          try {
            const img = decode(await cached.file.bytes());
            if (img) {
              keep(store, t, img, cached.at);
              changed();
              continue;
            }
          } catch {
            // Fetched again below.
          }
          disk.delete(t);
        }
        times.push(t);
        if (times.length >= BATCH) break;
      }
      if (times.length) return { store, times, step: pass === 'near' ? w.nearStep : COARSE_MS };
      inFlight.delete(uri);
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
      inFlight.delete(batch.store.uri);
    }
  }
}

async function fetchBatch({ store, times, step }: { store: Store; times: number[]; step: number }) {
  try {
    const got = await grabFrames(store.uri, {
      timesMs: times,
      maxWidth: FRAME_BOX,
      maxHeight: FRAME_BOX,
      quality: 0.6,
      toleranceMs: step / 2,
    });
    const dir = folderOf(store.uri);
    if (!dir.exists) dir.create({ intermediates: true });
    const disk = readDisk(store);
    for (const f of got) {
      const bytes = new Uint8Array(f.data);
      const img = decode(bytes);
      if (!img) continue;
      keep(store, f.timeMs, img, f.actualMs);
      try {
        const file = new File(dir, `${f.timeMs}@${Math.round(f.actualMs * 1000) / 1000}.jpg`);
        file.create({ overwrite: true });
        file.write(bytes);
        disk.set(f.timeMs, { file, at: f.actualMs });
      } catch {
        // Not cached on disk: fetched again next time.
      }
    }
  } catch {
    // The whole batch failed: its times count as failed below.
  }
  // Not fetched again this session (a frame the decoder couldn't give, or a batch that failed):
  // their tiles keep the nearest frame or the cover.
  for (const t of times) if (!store.images.has(t)) store.failed.add(t);
  changed();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** What a clip asks for: its file, the times near the screen (at `nearStep`), and its source
 * length (for the coarse frames). */
export type FrameWant = {
  id: string;
  uri: string;
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
    .map((w) => `${w.id}:${w.uri}:${w.nearStep}:${w.near.join(',')}:${w.sourceMs}`)
    .join('\n');
  useEffect(() => {
    // Per file (clips split from one file share it), in the order given (nearest the playhead
    // first): the order batches are taken in.
    wanted.clear();
    const near = new Set<string>();
    for (const w of wants) {
      storeFor(w.uri);
      const was = wanted.get(w.uri);
      const coarse = frameTimes(COARSE_MS, 0, w.sourceMs, w.sourceMs);
      if (was) was.near.push(...w.near);
      else wanted.set(w.uri, { near: [...w.near], nearStep: w.nearStep, coarse });
      for (const t of w.near) near.add(`${w.uri}|${t}`);
    }
    pinned = near;
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
