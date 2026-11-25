import type { Segment } from '@/db/schema';

// Draft-global timeline math for the editor, export and upload. A clip's edit is stored as
// settings (`editState`) and applied at play/export time — the editor's preview plays the
// ORIGINAL through the edit's window, speed and geometry, and the export's merge renders it
// once. Three kinds of clip resolve through `clipRender`:
//   - unedited: the original, whole;
//   - edited: the original, with `editState` applied;
//   - legacy baked (edited before settings were stored): the baked `editedFilename`, whole.
// Source time vs timeline time: a clip plays source [inMs, outMs] at `speed`, so it occupies
// `(outMs - inMs) / speed` of the timeline. The SQL in src/db/drafts.ts (`draftListQuery`)
// mirrors `effMs` through `edited_duration_ms`, which holds that timeline length for edits.

/** Crop rect, normalized 0–1 to the displayed frame after rotation/flip. */
export type ClipCrop = { x: number; y: number; w: number; h: number };

/** The source interval a split clip owns, retained when its edits are reset. */
export type ClipWindow = { startMs: number; endMs: number };

/** What the player / export must do to show a clip as edited. */
export type ClipRender = {
  /** Media file to play (relative path). */
  file: string;
  /** Source window, ms. */
  inMs: number;
  outMs: number;
  speed: number;
  muted: boolean;
  /** Counter-clockwise quarter turns, 0–3 (then `flipped` mirrors horizontally). */
  rotation: number;
  flipped: boolean;
  crop: ClipCrop | null;
};

/** The rendering-relevant part of an `editState` — everything but undo/redo history. */
export type ParsedEdit = Omit<ClipRender, 'file' | 'inMs' | 'outMs'> & {
  startMs: number;
  endMs: number;
  baseWindow?: ClipWindow;
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseWindow(v: unknown): ClipWindow | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const { startMs, endMs } = v as Record<string, unknown>;
  return isNum(startMs) && isNum(endMs) && startMs >= 0 && endMs > startMs
    ? { startMs, endMs }
    : undefined;
}

/** Keep a trim inside its split interval; a disjoint window falls back to that interval. */
function boundedWindow(startMs: number, endMs: number, baseWindow: ClipWindow): ClipWindow {
  const start = Math.max(startMs, baseWindow.startMs);
  const end = Math.min(endMs, baseWindow.endMs);
  return start < end ? { startMs: start, endMs: end } : { ...baseWindow };
}

function parseCrop(v: unknown): ClipCrop | null {
  if (typeof v !== 'object' || v === null) return null;
  const { x, y, w, h } = v as Record<string, unknown>;
  if (!isNum(x) || !isNum(y) || !isNum(w) || !isNum(h)) return null;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.001 || y + h > 1.001) return null;
  return { x, y, w, h };
}

// `editState` strings are parsed on every timeline read (cursor, bar, playhead maths run per
// frame), so parses are memoized by string. Bounded so a long session can't grow it forever.
const parseCache = new Map<string, ParsedEdit | null>();
const PARSE_CACHE_LIMIT = 256;

/**
 * The rendering fields of an `editState`, or null when it's missing or unusable (the clip
 * then plays as unedited — the editor treats a bad state the same way).
 */
export function parseEdit(editState: string | null | undefined): ParsedEdit | null {
  if (!editState) return null;
  const cached = parseCache.get(editState);
  if (cached !== undefined) return cached;
  let parsed: ParsedEdit | null = null;
  try {
    const o: unknown = JSON.parse(editState);
    if (typeof o === 'object' && o !== null) {
      const {
        startMs,
        endMs,
        rotation,
        flipped,
        crop,
        muted,
        speed,
        baseWindow: rawBase,
      } = o as Record<string, unknown>;
      if (
        isNum(startMs) &&
        isNum(endMs) &&
        startMs >= 0 &&
        endMs > startMs &&
        isNum(rotation) &&
        rotation >= 0 &&
        rotation <= 3 &&
        isNum(speed) &&
        speed >= 0.25 &&
        speed <= 4
      ) {
        const baseWindow = parseWindow(rawBase);
        parsed = {
          ...(baseWindow ? boundedWindow(startMs, endMs, baseWindow) : { startMs, endMs }),
          rotation: Math.round(rotation),
          flipped: flipped === true,
          crop: parseCrop(crop),
          muted: muted === true,
          speed,
          ...(baseWindow && { baseWindow }),
        };
      }
    }
  } catch {
    parsed = null;
  }
  if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.clear();
  parseCache.set(editState, parsed);
  return parsed;
}

/** How to play / render this clip (see the header for the three kinds). */
export function clipRender(s: Segment): ClipRender {
  const edit = s.editedFilename ? null : parseEdit(s.editState);
  if (edit) {
    return {
      file: s.originalFilename,
      // The saved window, clamped to the source (a shorter re-imported original can't leave the
      // out-point past its end).
      inMs: Math.min(edit.startMs, s.durationMs),
      outMs: Math.min(edit.endMs, s.durationMs),
      speed: edit.speed,
      muted: edit.muted,
      rotation: edit.rotation,
      flipped: edit.flipped,
      crop: edit.crop,
    };
  }
  return {
    file: s.editedFilename ?? s.originalFilename,
    inMs: 0,
    outMs: s.editedFilename ? (s.editedDurationMs ?? s.durationMs) : s.durationMs,
    speed: 1,
    muted: false,
    rotation: 0,
    flipped: false,
    crop: null,
  };
}

/** The clip's media file (the original, or a legacy baked edit). */
export const effFile = (s: Segment) => clipRender(s).file;
/** Source in-point, ms. */
export const inMs = (s: Segment) => clipRender(s).inMs;
/** Source out-point, ms. */
export const outMs = (s: Segment) => clipRender(s).outMs;
/** What the clip contributes to the draft's timeline, ms: its window at its speed. */
export const effMs = (s: Segment) => {
  const r = clipRender(s);
  return Math.max(0, (r.outMs - r.inMs) / r.speed);
};

/** Timeline length of an edit, ms — what `edited_duration_ms` stores for an edited clip. */
export function editTimelineMs(editState: string): number | null {
  const e = parseEdit(editState);
  return e ? Math.round((e.endMs - e.startMs) / e.speed) : null;
}

/**
 * An `editState` reduced to what changes the rendered video, in a fixed key order — no undo/redo
 * history, crop rounded — so it is stable as a cache key and small to pass to `merge()`.
 * Null when the state is unusable.
 */
export function canonicalEdit(editState: string | null | undefined): string | null {
  const e = parseEdit(editState);
  if (!e) return null;
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return JSON.stringify({
    v: 1,
    startMs: e.startMs,
    endMs: e.endMs,
    rotation: e.rotation,
    flipped: e.flipped,
    crop: e.crop && {
      x: round(e.crop.x),
      y: round(e.crop.y),
      w: round(e.crop.w),
      h: round(e.crop.h),
    },
    muted: e.muted,
    speed: e.speed,
    ...(e.baseWindow && { baseWindow: e.baseWindow }),
  });
}

/** Whole source, or the half a split owns, with default transforms and playback settings. */
export function segmentDefaults(s: Segment): ParsedEdit {
  const baseWindow = s.editedFilename ? undefined : parseEdit(s.editState)?.baseWindow;
  return {
    startMs: baseWindow?.startMs ?? 0,
    endMs:
      baseWindow?.endMs ?? (s.editedFilename ? (s.editedDurationMs ?? s.durationMs) : s.durationMs),
    rotation: 0,
    flipped: false,
    crop: null,
    muted: false,
    speed: 1,
    ...(baseWindow && { baseWindow }),
  };
}

/** Reset preserves a split's source bounds; an ordinary clip can clear its edit entirely. */
export function resetSegmentEdit(s: Segment): string | null {
  const edit = segmentDefaults(s);
  return edit.baseWindow ? canonicalEdit(JSON.stringify(edit)) : null;
}

/** Normalize a raw save/reset without allowing it to erase or expand a split's source bounds. */
export function segmentEditValue(s: Segment, value: string | null | undefined): string | null {
  if (value == null) return resetSegmentEdit(s);
  const edit = parseEdit(value);
  if (!edit) throw new Error('Unusable clip edit');
  const baseWindow = s.editedFilename ? undefined : parseEdit(s.editState)?.baseWindow;
  // Raw editor states may carry fields outside the render settings (including older per-clip
  // history). Preserve that existing storage contract; only a split's bounds need normalizing.
  if (!baseWindow) return value;
  const bounded = canonicalEdit(JSON.stringify({ ...edit, baseWindow }))!;
  return JSON.stringify({ ...JSON.parse(value), ...JSON.parse(bounded) });
}

/** Split the rendered source interval without copying or encoding its underlying media. */
export function splitSegmentAt(
  s: Segment,
  sourceMs: number,
  rightId: string,
): { left: Segment; right: Segment } {
  const { file, inMs, outMs, ...settings } = clipRender(s);
  if (!Number.isFinite(sourceMs) || sourceMs <= inMs || sourceMs >= outMs) {
    throw new Error('The split point must be inside the clip');
  }
  if (!rightId || rightId === s.id) throw new Error('The split needs a new clip id');
  const durationMs = s.editedFilename ? (s.editedDurationMs ?? s.durationMs) : s.durationMs;
  const half = (id: string, startMs: number, endMs: number): Segment => {
    const editState = canonicalEdit(
      JSON.stringify({ ...settings, startMs, endMs, baseWindow: { startMs, endMs } }),
    )!;
    return {
      ...s,
      id,
      originalFilename: file,
      durationMs,
      editedFilename: null,
      editedDurationMs: editTimelineMs(editState),
      editState,
    };
  };
  return { left: half(s.id, inMs, sourceMs), right: half(rightId, sourceMs, outMs) };
}

/**
 * What a clip renders to, as a cache key: its file, plus the canonical edit when it has one.
 * Unedited and legacy-baked clips key on the file alone — the same string as before edits were
 * stored as settings, so their cached exports and transcripts stay valid.
 */
export function renderKey(s: Segment): string {
  const file = effFile(s);
  const edit = s.editedFilename ? null : canonicalEdit(s.editState);
  return edit ? `${file}#${edit}` : file;
}

/**
 * Stable signature of what a segment set renders to, in order. Changes on add/remove/reorder
 * and on any edit (a new render key). Used as the merge cache key (`useExport`) and the
 * merged-transcript staleness key (`draft_transcripts.signature`) so both invalidate in lockstep
 * when the merged timeline moves.
 */
export const segmentSignature = (segments: Segment[]): string => segments.map(renderKey).join('|');

/** Draft-global prefix sums: `offsets[i]` = total effective ms before clip `i`. */
export function segmentOffsets(segments: Segment[]): number[] {
  const offsets: number[] = [];
  let acc = 0;
  for (const s of segments) {
    offsets.push(acc);
    acc += effMs(s);
  }
  return offsets;
}

/**
 * Index of the playable segment containing draft-global `ms` — zero-length clips
 * (e.g. `durationMs: 0` from a failed native read) are skipped, never landed on.
 * Returns -1 when no segment is playable.
 */
export function indexAtGlobalMs(segments: Segment[], offsets: number[], ms: number): number {
  let index = -1;
  for (let i = 0; i < segments.length; i++) {
    if (effMs(segments[i]) <= 0) continue;
    if (offsets[i] <= ms) index = i;
    else break;
  }
  return index;
}
