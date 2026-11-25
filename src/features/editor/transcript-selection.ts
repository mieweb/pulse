import type { ClipWindow } from '@/utils/segment-window';

type Source = { clipId: string; inMs: number; outMs: number };
type Word = { id: string; clipId: string; index: number; startMs: number; endMs: number };

/** Passage cuts include pauses and intervening beats; individual word selections keep gaps
 * between unselected words. All values stay in each source file's millisecond clock. */
export function transcriptSelectionRanges(
  sources: readonly Source[],
  words: readonly Word[],
  selected: ReadonlySet<string>,
  passage: boolean,
): Map<string, ClipWindow[]> {
  const out = new Map<string, ClipWindow[]>();
  const chosen = words.filter((word) => selected.has(word.id));
  if (!chosen.length) return out;
  if (passage) {
    const first = chosen[0];
    const last = chosen[chosen.length - 1];
    const from = sources.findIndex((source) => source.clipId === first.clipId);
    const to = sources.findIndex((source) => source.clipId === last.clipId);
    if (from < 0 || to < from) return out;
    sources.slice(from, to + 1).forEach((source, index) => {
      const startMs = Math.max(source.inMs, index === 0 ? first.startMs : source.inMs);
      const endMs = Math.min(source.outMs, index === to - from ? last.endMs : source.outMs);
      if (endMs > startMs) out.set(source.clipId, [{ startMs, endMs }]);
    });
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
