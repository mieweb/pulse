import { type ClipAnchor, END } from '@/core/clip-anchor';
import { addSegment } from '@/db/drafts';
import { describeError, formatSeconds } from '@/features/upload/core/upload-log';
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
 * never after a cancel). `onAdded` runs once the segment row is written, before this resolves: a
 * beat after the insert is announced (`onClipsAdded` listeners have run by then), not with it.
 * `anchor` says where in the draft the clip goes (default the end); as a function it is called just
 * before the row is written (`insertSegments`), so a caller that passes its live cursor (the
 * recorder's import) follows a cursor moved during the conversion, and one that passes a fixed
 * place (a screen take, pinned where the cursor was when Record screen was tapped) gets that place.
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
    anchor,
  }: {
    signal: AbortSignal;
    onProgress?: (fraction: number) => void;
    onAdded?: () => void;
    anchor?: ClipAnchor | (() => ClipAnchor);
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
  const added = await storeClip(conformed?.path ?? uri, {
    draftId: id,
    segmentId: segId,
    owned: conformed != null,
    signal,
    anchor: anchor ?? END,
  });
  if (!added) return { status: 'cancelled' };
  onAdded?.();
  return { status: 'added', draftId: id, segmentId: segId };
}

/**
 * The steps after the conversion, shared by every clip made outside the recorder (an import, a
 * screen recording, an image): `file`, already in the recorder's format, is copied into draft
 * `draftId`'s segments folder as clip `segmentId`, its length read, its cover rendered, and its row
 * written at `anchor` (`insertSegments`). `owned` says `file` is a conversion's output in the
 * OS-purgeable cache dir: it's deleted once copied (or the copy failed); otherwise it's only read.
 *
 * Resolves true once the row is written, false when `signal` aborted on the way (nothing is left
 * behind). Throws when the copy, the length or the db write fails, its files deleted.
 */
export async function storeClip(
  file: string,
  {
    draftId,
    segmentId,
    owned,
    signal,
    anchor,
  }: {
    draftId: string;
    segmentId: string;
    owned: boolean;
    signal: AbortSignal;
    anchor: ClipAnchor | (() => ClipAnchor);
  },
): Promise<boolean> {
  let originalFilename: string;
  try {
    originalFilename = await copyIntoSegments(file, draftId, segmentId);
  } finally {
    if (owned) deleteQuietly(file);
  }
  // Until the row is in, nothing points at the copy or its cover: a cancel or a throw (the draft
  // deleted meanwhile, a full disk) takes them back out.
  const thumbRel = thumbRelPath(draftId, segmentId);
  const discard = () => {
    deleteSegmentFile(thumbRel);
    deleteSegmentFile(originalFilename);
  };
  try {
    const durationMs = await getDurationMs(absolutize(originalFilename));
    if (signal.aborted) {
      discard();
      return false;
    }
    // The cover first, then the row: an import can be cancelled while its cover renders, and then
    // nothing is added.
    const ok = await generateThumbnailFile(absolutize(originalFilename), absolutize(thumbRel));
    if (signal.aborted) {
      discard();
      return false;
    }
    await addSegment(
      draftId,
      { id: segmentId, originalFilename, durationMs, thumbnail: ok ? thumbRel : null },
      anchor,
    );
    return true;
  } catch (e) {
    discard();
    throw e;
  }
}
