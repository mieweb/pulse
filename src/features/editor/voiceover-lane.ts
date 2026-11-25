/** The narration bar's painted width, including its two-point gap and minimum visible size. */
export function voiceoverWidth(durationMs: number, dpPerMs: number): number {
  'worklet';
  return Math.max(2, durationMs * dpPerMs - 2);
}

/** Hit the last-painted bar; a tiny bar's visual overflow seeks only to its actual audio end. */
export function voiceoverTapTime(
  takes: readonly { startMs: number; trimStartMs: number; trimEndMs: number }[],
  timeMs: number,
  dpPerMs: number,
): number | null {
  'worklet';
  if (!Number.isFinite(timeMs) || !Number.isFinite(dpPerMs) || dpPerMs <= 0) return null;
  const x = timeMs * dpPerMs;
  if (!Number.isFinite(x)) return null;
  for (let i = takes.length - 1; i >= 0; i--) {
    const take = takes[i];
    const duration = take.trimEndMs - take.trimStartMs;
    const end = take.startMs + duration;
    if (
      !Number.isFinite(take.startMs) ||
      !Number.isFinite(take.trimStartMs) ||
      !Number.isFinite(take.trimEndMs) ||
      !Number.isFinite(end) ||
      take.startMs < 0 ||
      take.trimStartMs < 0 ||
      duration <= 0
    )
      continue;
    const left = take.startMs * dpPerMs;
    const right = left + voiceoverWidth(duration, dpPerMs);
    if (Number.isFinite(left) && Number.isFinite(right) && x >= left && x < right) {
      return Math.min(timeMs, end);
    }
  }
  return null;
}
