import type { ClipWords } from '@/db/clip-transcripts';
import type { Segment } from '@/db/schema';
import { clipRender, effMs } from '@/utils/segment-window';

import { linesFromWords } from './group-lines';
import type { TranscriptLine, TranscriptWord } from './whisper';

/** The draft's captions, or the clips still to transcribe before they can be composed. */
export type Composed =
  | { ready: true; lines: TranscriptLine[]; durationMs: number }
  | { ready: false; missing: string[] };

/**
 * The draft's captions from its clips' own transcripts, through the clips' edits: clips in order
 * (zero-length ones left out, as the merge leaves them out), a muted clip's words dropped, a word
 * kept while its middle is inside the clip's trim window, and its times moved to the draft's
 * timeline: `start + (t - in) / speed`. Times stay in centiseconds. Not ready while a clip that
 * speaks has no transcript of the file it plays from.
 */
export function composeCaptions(segments: Segment[], clips: Map<string, ClipWords>): Composed {
  const words: TranscriptWord[] = [];
  const missing: string[] = [];
  let offsetMs = 0;
  for (const s of segments) {
    const lengthMs = effMs(s);
    if (lengthMs <= 0) continue;
    const r = clipRender(s);
    if (!r.muted) {
      const own = clips.get(s.id);
      if (!own || own.file !== r.file) {
        missing.push(s.id);
      } else {
        const at = (ms: number) => (offsetMs + (ms - r.inMs) / r.speed) / 10;
        const endCs = (offsetMs + lengthMs) / 10;
        for (const w of own.words) {
          const mid = ((w.t0 + w.t1) / 2) * 10;
          if (mid < r.inMs || mid >= r.outMs) continue;
          words.push({
            text: w.text,
            t0: Math.round(Math.max(offsetMs / 10, at(w.t0 * 10))),
            t1: Math.round(Math.min(endCs, at(w.t1 * 10))),
          });
        }
      }
    }
    offsetMs += lengthMs;
  }
  if (missing.length) return { ready: false, missing };
  return { ready: true, lines: linesFromWords(words), durationMs: Math.round(offsetMs) };
}
