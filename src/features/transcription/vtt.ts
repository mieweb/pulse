import { wordGap } from './group-lines';
import type { TranscriptLine } from './whisper';

// Our `TranscriptLine` times are centiseconds (1/100 s); WebVTT timestamps are milliseconds.
const csToMs = (cs: number) => Math.round(cs * 10);

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Milliseconds → WebVTT timestamp (`00:00:01.500`). */
function msToVttTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${String(clamped % 1000).padStart(3, '0')}`;
}

/**
 * Serialize caption lines to a WebVTT document. WebVTT carries the word-level timing whisper
 * gives us as inline cue timestamps (`word <00:00:01.500>word` — the karaoke syntax), so a web
 * viewer can highlight the exact spoken word the way the app's caption (skia-caption.tsx) does. Lines
 * without word data emit plain cues — viewers fall back to whatever line-level treatment they
 * have. `y` (where the captions were moved to: the caption's centre, a fraction of the height)
 * becomes each cue's `line:` setting, centred on that line.
 */
/** Text as cue text: `&`, `<` and `>` escaped (so typed text can't open a tag or end a cue). */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function linesToVtt(lines: readonly TranscriptLine[], y?: number | null): string {
  const settings = y == null ? '' : ` line:${Math.round(y * 100)}%,center`;
  // WebVTT needs a cue to end after it starts, and each inline timestamp to be later than the one
  // before it and inside the cue: a word whose time doesn't move forward (equal token times, a
  // word clamped to a clip's edge) is written without one, and an empty cue is left out.
  const cues = lines
    .filter((line) => csToMs(line.t1) > csToMs(line.t0))
    .map((line) => {
      const start = csToMs(line.t0);
      const end = csToMs(line.t1);
      const timing = `${msToVttTime(start)} --> ${msToVttTime(end)}${settings}`;
      const words = line.words;
      let last = start;
      const text = words?.length
        ? words
            .map((w, i) => {
              if (i === 0) return esc(w.text);
              const gap = wordGap(words[i - 1].text, w.text);
              const at = csToMs(w.t0);
              if (at <= last || at >= end) return `${gap}${esc(w.text)}`;
              last = at;
              return `${gap}<${msToVttTime(at)}>${esc(w.text)}`;
            })
            .join('')
        : esc(line.text);
      return `${timing}\n${text}`;
    });
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}
