import type { CaptionStyle } from './caption-style';
import { wordGap, widthOf } from './group-lines';
import type { TranscriptLine, TranscriptWord } from './whisper';

// A caption cue is up to ~42 characters (group-lines.ts); it shows on one row up to this width,
// else on two rows split near the middle. Deciding the rows here, not in a text engine, is what
// keeps every renderer (the previews, a burn-in on the exported frames) breaking the same way.
const ROW_WIDTH = 24;

/** A word as drawn: `lead` goes before it on its row ('' first on a row, else ' ' or ''). */
export type TrackWord = { lead: string; text: string; t0Ms: number; t1Ms: number };
/** One caption on the timeline: its rows of words, drawn as given (never re-wrapped). */
export type TrackCue = { t0Ms: number; t1Ms: number; rows: TrackWord[][] };
/**
 * Everything needed to draw a draft's captions onto its video, independent of any UI: the style
 * (units of the picture) and each cue's rows and word times (timeline ms). What a burn-in at merge
 * time takes; the previews draw from the same rows and style.
 */
export type CaptionTrack = { version: 1; style: CaptionStyle; cues: TrackCue[] };

/** A line's words as the rows they're drawn on: one row, or two of about equal width. */
export function captionRows(line: TranscriptLine): TranscriptWord[][] {
  const words = line.words?.length ? line.words : [{ text: line.text, t0: line.t0, t1: line.t1 }];
  // Width up to (excluding) word i, with the gaps between words.
  const upTo: number[] = [0];
  for (let i = 0; i < words.length; i++) {
    const gap = i > 0 ? wordGap(words[i - 1].text, words[i].text).length : 0;
    upTo.push(upTo[i] + gap + widthOf(words[i].text));
  }
  const total = upTo[words.length];
  if (total <= ROW_WIDTH || words.length < 2) return [words];
  // The split that makes the wider row narrowest (the gap at the split goes away).
  let best = 1;
  let bestWidth = Infinity;
  for (let k = 1; k < words.length; k++) {
    const gap = wordGap(words[k - 1].text, words[k].text).length;
    const wider = Math.max(upTo[k], total - upTo[k] - gap);
    if (wider < bestWidth) {
      bestWidth = wider;
      best = k;
    }
  }
  return [words.slice(0, best), words.slice(best)];
}

/** The draft's captions (timeline centiseconds) as a track for drawing onto the video. */
export function captionTrack(lines: readonly TranscriptLine[], style: CaptionStyle): CaptionTrack {
  return {
    version: 1,
    style,
    cues: lines.map((line) => ({
      t0Ms: line.t0 * 10,
      t1Ms: line.t1 * 10,
      rows: captionRows(line).map((row) =>
        row.map((w, i) => ({
          lead: i > 0 ? wordGap(row[i - 1].text, w.text) : '',
          text: w.text,
          t0Ms: w.t0 * 10,
          t1Ms: w.t1 * 10,
        })),
      ),
    })),
  };
}
