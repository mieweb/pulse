import type { ClipWindow } from '@/utils/segment-window';

type Source = { clipId: string; inMs: number; outMs: number };
type Word = { id: string; clipId: string; index: number; startMs: number; endMs: number };

/** Passage cuts include pauses and intervening beats. `runs` applies that behavior separately
 * to each contiguous selected word run, preserving unchecked gaps. Individual word selection
 * keeps its existing within-beat grouping. Values stay in each source file's millisecond clock. */
export function transcriptSelectionRanges(
  sources: readonly Source[],
  words: readonly Word[],
  selected: ReadonlySet<string>,
  passage: boolean | 'runs',
): Map<string, ClipWindow[]> {
  const out = new Map<string, ClipWindow[]>();
  if (!selected.size) return out;
  const addPassage = (first: Word, last: Word) => {
    const from = sources.findIndex((source) => source.clipId === first.clipId);
    const to = sources.findIndex((source) => source.clipId === last.clipId);
    if (from < 0 || to < from) return;
    sources.slice(from, to + 1).forEach((source, index) => {
      const startMs = Math.max(source.inMs, index === 0 ? first.startMs : source.inMs);
      const endMs = Math.min(source.outMs, index === to - from ? last.endMs : source.outMs);
      if (endMs > startMs) {
        const ranges = out.get(source.clipId) ?? [];
        ranges.push({ startMs, endMs });
        out.set(source.clipId, ranges);
      }
    });
  };
  if (passage === true) {
    const chosen = words.filter((word) => selected.has(word.id));
    if (chosen.length) addPassage(chosen[0], chosen[chosen.length - 1]);
    return out;
  }
  if (passage === 'runs') {
    let first: Word | null = null;
    let last: Word | null = null;
    for (const word of words) {
      if (selected.has(word.id)) {
        first ??= word;
        last = word;
      } else if (first && last) {
        addPassage(first, last);
        first = last = null;
      }
    }
    if (first && last) addPassage(first, last);
    return out;
  }
  let previous: Word | null = null;
  for (const word of words) {
    if (!selected.has(word.id)) {
      previous = null;
      continue;
    }
    const ranges = out.get(word.clipId) ?? [];
    if (previous?.clipId === word.clipId && previous.index + 1 === word.index) {
      ranges[ranges.length - 1].endMs = Math.max(ranges[ranges.length - 1].endMs, word.endMs);
    } else ranges.push({ startMs: word.startMs, endMs: word.endMs });
    out.set(word.clipId, ranges);
    previous = word;
  }
  return out;
}
