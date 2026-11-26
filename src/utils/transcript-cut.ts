import type { Segment } from '@/db/schema';
import {
  canonicalEdit,
  clipRender,
  editTimelineMs,
  SPLIT_BOUNDARY_TOLERANCE_MS,
  type ClipRender,
  type ClipWindow,
} from './segment-window';

/** A first-pass speech cut keeps playable footage on both sides of one source interval. */
export function interiorCutWindow(
  render: Pick<ClipRender, 'inMs' | 'outMs' | 'speed'>,
  startMs: number,
  endMs: number,
  fps: number,
): ClipWindow | null {
  const { inMs, outMs, speed } = render;
  if (
    ![inMs, outMs, speed, startMs, endMs, fps].every(Number.isFinite) ||
    speed <= 0 ||
    fps <= 0 ||
    startMs <= inMs ||
    endMs >= outMs ||
    startMs >= endMs
  )
    return null;
  // The native engines trim at source frames. Do not create a cut or retained piece that
  // disappears when their frame snapping and whole-ms timeline lengths are applied.
  const frameMs = 1000 / fps;
  const start = Math.round(Math.round(startMs / frameMs) * frameMs);
  const end = Math.round(Math.round(endMs / frameMs) * frameMs);
  const atLeastFrame = (ms: number) => ms >= Math.max(1, Math.floor(frameMs));
  if (
    !atLeastFrame(start - inMs) ||
    !atLeastFrame(end - start) ||
    !atLeastFrame(outMs - end) ||
    (start - inMs) / speed <= SPLIT_BOUNDARY_TOLERANCE_MS ||
    (end - start) / speed <= SPLIT_BOUNDARY_TOLERANCE_MS ||
    (outMs - end) / speed <= SPLIT_BOUNDARY_TOLERANCE_MS
  )
    return null;
  return { startMs: start, endMs: end };
}

/** Keep two source ranges around removed speech; neither Reset nor later trims reveal it. */
export function cutSegmentAt(
  segment: Segment,
  startMs: number,
  endMs: number,
  rightId: string,
  fps: number,
): { left: Segment; right: Segment } {
  const { file, inMs, outMs, ...settings } = clipRender(segment);
  const cut = interiorCutWindow({ inMs, outMs, speed: settings.speed }, startMs, endMs, fps);
  if (!cut) throw new Error('Choose a word with video remaining on both sides of this beat.');
  if (!rightId || rightId === segment.id) throw new Error('The speech cut needs a new clip id.');
  const durationMs = segment.editedFilename
    ? (segment.editedDurationMs ?? segment.durationMs)
    : segment.durationMs;
  const kept = (id: string, startMs: number, endMs: number): Segment => {
    const editState = canonicalEdit(
      JSON.stringify({ ...settings, startMs, endMs, baseWindow: { startMs, endMs } }),
    )!;
    return {
      ...segment,
      id,
      originalFilename: file,
      durationMs,
      editedFilename: null,
      editedDurationMs: editTimelineMs(editState),
      editState,
    };
  };
  return {
    left: kept(segment.id, inMs, cut.startMs),
    right: kept(rightId, cut.endMs, outMs),
  };
}
