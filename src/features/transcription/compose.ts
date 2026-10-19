import type { ClipWords } from '@/db/clip-transcripts';
import { parseCaptionEdit } from '@/db/captions';
import type { Segment } from '@/db/schema';
import { clipRender, effMs } from '@/utils/segment-window';

import { linesFromWords } from './group-lines';
import type { TranscriptLine, TranscriptWord } from './whisper';

/** A caption on the draft's timeline, and where its words are in its clip's words. */
export type CaptionLine = TranscriptLine & {
  clipId: string;
  /** The line's words are `from` … `to` (exclusive) of the clip's words (`clipWords`). */
  from: number;
  to: number;
};

/** The draft's captions, composed from what its clips have so far. */
export type Composed = {
  lines: CaptionLine[];
  /** The timeline's length, ms. */
  durationMs: number;
  /** Clips that speak with no transcript of the file they play yet (the queue's work). */
  missing: string[];
  /** Clips the model couldn't transcribe. */
  failed: string[];
};

/**
 * A clip's words, in the file it plays (centiseconds): the person's edit when it's of that file,
 * else the model's transcript of it. `null` while there's neither.
 */
export function clipWords(
  s: Segment,
  clips: ReadonlyMap<string, ClipWords>,
): { words: TranscriptWord[]; edited: boolean; failed: boolean } | null {
  const file = clipRender(s).file;
  const edit = parseCaptionEdit(s.captionEdit);
  if (edit && edit.file === file) return { words: edit.words, edited: true, failed: false };
  const own = clips.get(s.id);
  if (!own || own.file !== file) return null;
  return { words: own.words, edited: false, failed: own.failed };
}

/**
 * The draft's captions from its clips' words, through the clips' edits: clips in order
 * (zero-length ones left out, as the merge leaves them out), a muted clip's words dropped, a word
 * kept while its middle is inside the clip's trim window, and its times moved to the draft's
 * timeline: `start + (t - in) / speed`. Each clip's words make their own lines, so a caption never
 * runs across a cut (or over a muted clip between two that speak). Times stay in centiseconds.
 * Complete when `missing` is empty.
 */
export function composeCaptions(
  segments: readonly Segment[],
  clips: ReadonlyMap<string, ClipWords>,
): Composed {
  const lines: CaptionLine[] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  let offsetMs = 0;
  for (const s of segments) {
    const lengthMs = effMs(s);
    if (lengthMs <= 0) continue;
    const r = clipRender(s);
    const own = r.muted ? null : clipWords(s, clips);
    if (!r.muted && !own) missing.push(s.id);
    if (own?.failed) failed.push(s.id);
    if (own && own.words.length) {
      const at = (ms: number) => (offsetMs + (ms - r.inMs) / r.speed) / 10;
      const startCs = offsetMs / 10;
      const endCs = (offsetMs + lengthMs) / 10;
      // Each timeline word, and the index of the clip word it came from.
      const index = new Map<TranscriptWord, number>();
      const words: TranscriptWord[] = [];
      own.words.forEach((w, i) => {
        const mid = ((w.t0 + w.t1) / 2) * 10;
        if (mid < r.inMs || mid >= r.outMs) return;
        const mapped = {
          text: w.text,
          t0: Math.round(Math.max(startCs, at(w.t0 * 10))),
          t1: Math.round(Math.min(endCs, at(w.t1 * 10))),
        };
        index.set(mapped, i);
        words.push(mapped);
      });
      for (const line of linesFromWords(words)) {
        const first = line.words?.[0];
        const last = line.words?.[line.words.length - 1];
        if (!first || !last) continue;
        lines.push({
          ...line,
          clipId: s.id,
          from: index.get(first) ?? 0,
          to: (index.get(last) ?? 0) + 1,
        });
      }
    }
    offsetMs += lengthMs;
  }
  return { lines, durationMs: Math.round(offsetMs), missing, failed };
}

/** The line at timeline `posCs` (centiseconds): its index in `lines` (sorted), or -1. */
export function lineAt(lines: readonly TranscriptLine[], posCs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = lines[mid];
    if (posCs < l.t0) hi = mid - 1;
    else if (posCs > l.t1) lo = mid + 1;
    else return mid;
  }
  return -1;
}
