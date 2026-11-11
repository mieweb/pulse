import { addSegment } from '@/db/drafts';
import { describeError, formatSeconds } from '@/features/upload/upload-log';
import { conformToContract, type ConformOutcome } from '@/utils/contract-gate';
import {
  absolutize,
  copyIntoSegments,
  deleteQuietly,
  deleteSegmentFile,
  thumbRelPath,
} from '@/utils/file-store';
import { generateThumbnailFile, getDurationMs } from '@/utils/video';

import { importLog } from './import-log';
import { getRecorderFormat } from './recorder-format';

export type ExternalClipResult =
  | { status: 'added'; draftId: string; segmentId: string }
  /** `signal` aborted: nothing was added and nothing is left behind. */
  | { status: 'cancelled' }
  /** The conversion refused the file; `why` is the reason `importFailureCopy` reads. */
  | { status: 'rejected'; why: string };

/**
 * Add a video file from outside the recorder (a picked video, a screen recording) to a draft as a
 * segment. The file is conformed ONCE, here, to the reels contract AND the recorder's own
 * signature (coded orientation, fps, AAC layout), so a draft mixing recordings and imports merges
 * with no re-encode; a file already in that format keeps its original bytes. The policy lives in
 * decideImport (§ imports), the conversion (pulse-editor `conform`) and its verification in
 * conformToContract. Fails CLOSED: a clip that can't be probed or conformed is never stored.
 *
 * `uri` is only read (copied), never moved or deleted. `draftId` may be a function: it is then
 * called once the conversion has finished, so a cancelled or rejected file never creates a draft.
 * `segmentId` defaults to `{draftId}-{now}`; a caller that retries passes its own to stay
 * idempotent. `signal` cancels it at every step, undoing what's been done, so the clip lands whole
 * in its draft or not at all. `onProgress` gets the conversion's progress in whole percents (and
 * never after a cancel). `onAdded` runs synchronously right after the segment row is written.
 *
 * Throws on anything other than a cancel or a conversion refusal (a copy or a db write failing).
 */
export async function addExternalClip(
  uri: string,
  draftId: string | (() => Promise<string>),
  segmentId: string | null,
  {
    signal,
    onProgress,
    onAdded,
  }: {
    signal: AbortSignal;
    onProgress?: (fraction: number) => void;
    onAdded?: () => void;
  },
): Promise<ExternalClipResult> {
  const started = Date.now();
  const target = await getRecorderFormat();
  // Native reports often (iOS every 0.5 %, Android every 100 ms); whole percents are plenty
  // for the ring. A report that lands after a cancel is dropped.
  let shown = -1;
  const progress = (fraction: number) => {
    if (signal.aborted || (fraction < 1 && fraction - shown < 0.01)) return;
    shown = fraction;
    onProgress?.(fraction);
  };
  let conformed: ConformOutcome | null;
  try {
    conformed = await conformToContract(uri, target, signal, progress);
  } catch (e) {
    if (signal.aborted) return { status: 'cancelled' };
    const why = describeError(e);
    importLog.warn(`failed after ${formatSeconds(Date.now() - started)}: ${why}`);
    return { status: 'rejected', why };
  }
  // Finished just as Pulse left: still cancelled, as promised.
  if (signal.aborted) {
    if (conformed) deleteQuietly(conformed.path);
    return { status: 'cancelled' };
  }
  if (conformed) {
    importLog.info(
      `converted with ${conformed.engine} in ${formatSeconds(Date.now() - started)}` +
        (conformed.mergeMatch ? ', matches the recorder' : '') +
        ` — ${conformed.notes.join('; ')}`,
    );
  } else {
    importLog.info('already in the recorder format — kept as is');
  }

  const id = typeof draftId === 'string' ? draftId : await draftId();
  if (signal.aborted) {
    if (conformed) deleteQuietly(conformed.path);
    return { status: 'cancelled' };
  }
  const segId = segmentId ?? `${id}-${Date.now()}`;
  const originalFilename = await copyIntoSegments(conformed?.path ?? uri, id, segId);
  // The conform output lives in the OS-purgeable cache dir; drop it once copied.
  if (conformed) deleteQuietly(conformed.path);
  const durationMs = await getDurationMs(absolutize(originalFilename));
  if (signal.aborted) {
    deleteSegmentFile(originalFilename);
    return { status: 'cancelled' };
  }

  // The cover first, then the row: an import can be cancelled while its cover renders, and then
  // nothing is added.
  const thumbRel = thumbRelPath(id, segId);
  const ok = await generateThumbnailFile(absolutize(originalFilename), absolutize(thumbRel));
  if (signal.aborted) {
    if (ok) deleteSegmentFile(thumbRel);
    deleteSegmentFile(originalFilename);
    return { status: 'cancelled' };
  }
  await addSegment(id, {
    id: segId,
    originalFilename,
    durationMs,
    thumbnail: ok ? thumbRel : null,
  });
  onAdded?.();
  return { status: 'added', draftId: id, segmentId: segId };
}
