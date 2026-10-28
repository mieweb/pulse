import type { ClipWords } from '@/db/clip-transcripts';
import { parseCaptionEdit } from '@/db/captions';
import type { Segment } from '@/db/schema';
import { clipRender, effMs } from '@/utils/segment-window';

import { MIN_WORD_CS, type CaptionWord } from './caption-edits';
import { joinWords, linesFromWords } from './group-lines';
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
): { words: CaptionWord[]; edited: boolean; failed: boolean } | null {
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
      const span: ClipSpan = { offsetMs, lengthMs, inMs: r.inMs, outMs: r.outMs, speed: r.speed };
      // Each timeline word, and the index of the clip word it came from.
      const index = new Map<TranscriptWord, number>();
      const words: TranscriptWord[] = [];
      own.words.forEach((w, i) => {
        const mid = ((w.t0 + w.t1) / 2) * 10;
        if (mid < r.inMs || mid >= r.outMs) return;
        const mapped = { text: w.text, t0: timelineCs(span, w.t0), t1: timelineCs(span, w.t1) };
        index.set(mapped, i);
        words.push(mapped);
      });
      // An edited clip's sentences are where the person put them; otherwise grouped by length.
      const byStarts = own.words.some((w) => w.start);
      const grouped: TranscriptLine[] = [];
      if (byStarts) {
        let run: TranscriptWord[] = [];
        const flush = () => {
          if (!run.length) return;
          grouped.push({
            text: joinWords(run),
            t0: run[0].t0,
            t1: run[run.length - 1].t1,
            words: run,
          });
          run = [];
        };
        for (const w of words) {
          if (own.words[index.get(w) ?? 0]?.start) flush();
          run.push(w);
        }
        flush();
      }
      for (const line of byStarts ? grouped : linesFromWords(words)) {
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
  return { lines, missing, failed };
}

/** Where a clip sits on the timeline and the part of its file it plays (ms). */
export type ClipSpan = {
  offsetMs: number;
  lengthMs: number;
  inMs: number;
  outMs: number;
  speed: number;
};

/** Each clip's span, by id, as composeCaptions lays the clips out. */
export function clipSpans(segments: readonly Segment[]): Map<string, ClipSpan> {
  const out = new Map<string, ClipSpan>();
  let offsetMs = 0;
  for (const s of segments) {
    const lengthMs = effMs(s);
    if (lengthMs <= 0) continue;
    const r = clipRender(s);
    out.set(s.id, { offsetMs, lengthMs, inMs: r.inMs, outMs: r.outMs, speed: r.speed });
    offsetMs += lengthMs;
  }
  return out;
}

/** Timeline ms → the clip's file time, centiseconds. */
export const toFileCs = (span: ClipSpan, tlMs: number) =>
  (span.inMs + (tlMs - span.offsetMs) * span.speed) / 10;

/** The clip's file time (centiseconds) → timeline centiseconds, as captions are drawn: kept
 * within the clip, rounded to whole centiseconds. */
export function timelineCs(span: ClipSpan, fileCs: number): number {
  const cs = (span.offsetMs + (fileCs * 10 - span.inMs) / span.speed) / 10;
  const lo = span.offsetMs / 10;
  const hi = (span.offsetMs + span.lengthMs) / 10;
  return Math.round(Math.min(hi, Math.max(lo, cs)));
}

/** The line at timeline `posCs` (centiseconds): its index in `lines` (sorted), or -1. */
export function lineAt(lines: readonly TranscriptLine[], posCs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const l = lines[mid];
    if (posCs < l.t0) hi = mid - 1;
    // Half-open (up to, not including, its end): where two touch, the later one has it.
    else if (posCs >= l.t1) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * What word `word` of sentence `line` can be dragged to (timeline ms), or null: its box, its
 * start within lo0 … hi0 and its end within lo1 … hi1. Each edge moves only its own word and stops
 * at the neighbouring word's edge (or the sentence's, or the clip's), so words never overlap, and
 * the word stays at least MIN_WORD_CS long in its file's time.
 */
export function wordGripLimits(
  lines: readonly CaptionLine[],
  line: number,
  word: number,
  spans: ReadonlyMap<string, ClipSpan>,
): { box: { t0: number; t1: number }; lo0: number; hi0: number; lo1: number; hi1: number } | null {
  const l = lines[line];
  const span = l ? spans.get(l.clipId) : undefined;
  const ws = l?.words ?? [];
  const w = ws[word];
  if (!l || !span || !w) return null;
  const prev = line > 0 && lines[line - 1].clipId === l.clipId ? lines[line - 1] : null;
  const next =
    line + 1 < lines.length && lines[line + 1].clipId === l.clipId ? lines[line + 1] : null;
  const lo = prev ? prev.t1 * 10 : span.offsetMs;
  const hi = next ? next.t0 * 10 : span.offsetMs + span.lengthMs;
  // The shortest a word can be on the timeline: MIN_WORD_CS in its file's time (what setTimes
  // keeps), shorter when sped up and longer when slowed down.
  const min = (MIN_WORD_CS * 10) / span.speed;
  const pw = ws[word - 1];
  const nw = ws[word + 1];
  const lo0 = pw ? pw.t1 * 10 : lo;
  const hi1 = nw ? nw.t0 * 10 : hi;
  return {
    box: { t0: w.t0 * 10, t1: w.t1 * 10 },
    // Never a reversed range: a word already that short keeps the edge where it is.
    lo0,
    hi0: Math.max(lo0, w.t0 * 10, w.t1 * 10 - min),
    lo1: Math.min(hi1, w.t1 * 10, w.t0 * 10 + min),
    hi1,
  };
}
