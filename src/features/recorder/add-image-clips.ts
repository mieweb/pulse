import { imageClip, type ConformResult } from '@mieweb/pulse-editor';

import { type ClipAnchor, END } from '@/core/clip-anchor';
import { describeError, formatSeconds } from '@/features/upload/core/upload-log';
import { deleteQuietly } from '@/utils/file-store';
import { recorderEncodeFormat } from '@/utils/import-normalization';

import { storeClip } from './add-external-clip';
import { importLog } from './import-log';
import { getRecorderFormat } from './recorder-format';

/** How long an image shows in the draft (#308): 3 s, letterboxed on black. */
export const IMAGE_CLIP_MS = 3000;
export const IMAGE_CLIP_BACKGROUND = '#000000';

/** Where a batch is: image `index` (from 0) of `total`, that image's own progress 0–1. */
export type ImageBatchStep = { index: number; total: number; fraction: number };

export type ImageClipsResult = {
  /** The draft the clips went to; null when none was needed (nothing added). */
  draftId: string | null;
  /** The new clips' ids, in the order the images were given. */
  added: string[];
  /** The images that couldn't be made into a clip (by their place in `uris`), and why. */
  skipped: { index: number; why: string }[];
  /** `signal` aborted: the images from there on weren't added (those before it stay). */
  cancelled: boolean;
};

/**
 * Add images (photos, screenshots) to a draft as clips, one each, in the order given: each is made
 * into a 3 s clip in the recorder's format (pulse-editor `imageClip`: canvas, rotation tag, fps,
 * bitrate, a silent AAC track in the recorder's layout, stereo for a multichannel one:
 * `recorderEncodeFormat`), so its video joins recordings without re-encoding, then stored as an
 * import is (`storeClip`: copied into the draft, cover, row).
 *
 Every clip goes at `anchor`, read once, just before the first clip's row is written (as
 * `addExternalClip` does), and kept: a `ClipAnchor` stays put as clips land at it, so the batch
 * lands together and in order wherever the first landed, and keeps its place when one of its clips
 * is deleted mid-batch. Each clip is written as soon as it's made. An image that can't be made into a
 * clip (one this phone can't decode, a missing file) is skipped and the rest go on. `signal` stops
 * the batch: the image being made is dropped, those already added stay. `draftId` may be a
 * function, called once the first clip is made (so a batch of unreadable images never creates a
 * draft). `onWriting` gets each clip's id just before its row is written (so whoever hears the
 * insert, `onClipsAdded`, can tell it's this batch's); `onAdded` once `storeClip` has resolved,
 * after those listeners. `onProgress` reports in whole percents of the batch, and at each image's
 * start.
 *
 * `uris` are local files (`file://` or paths; Android also takes `content://`): only read, never
 * moved or deleted. Throws when storing a clip fails (a copy or a db write: a full disk), leaving
 * the clips added before it.
 */
export async function addImageClips(
  uris: readonly string[],
  draftId: string | (() => Promise<string>),
  {
    signal,
    anchor,
    onProgress,
    onWriting,
    onAdded,
  }: {
    signal: AbortSignal;
    anchor?: () => ClipAnchor;
    onProgress?: (step: ImageBatchStep) => void;
    onWriting?: (segmentId: string) => void;
    onAdded?: (segmentId: string) => void;
  },
): Promise<ImageClipsResult> {
  const result: ImageClipsResult = { draftId: null, added: [], skipped: [], cancelled: false };
  const total = uris.length;
  const options = {
    ...recorderEncodeFormat(await getRecorderFormat()),
    durationMs: IMAGE_CLIP_MS,
    background: IMAGE_CLIP_BACKGROUND,
  };
  let fixed: ClipAnchor | null = null;
  const at = () => (fixed ??= anchor?.() ?? END);
  const started = Date.now();
  // Whole percents of the batch are plenty for the ring (native reports far more often).
  let shown = -1;
  for (let index = 0; index < total; index++) {
    if (signal.aborted) break;
    const progress = (fraction: number) => {
      const overall = (index + fraction) / total;
      if (signal.aborted || (fraction > 0 && fraction < 1 && overall - shown < 0.01)) return;
      shown = overall;
      onProgress?.({ index, total, fraction });
    };
    progress(0);
    let made: ConformResult;
    try {
      made = await imageClip(uris[index], options, { signal, onProgress: progress });
    } catch (e) {
      if (signal.aborted) break;
      const why = describeError(e);
      importLog.warn(`image ${index + 1} of ${total} skipped: ${why}`);
      result.skipped.push({ index, why });
      continue;
    }
    if (signal.aborted) {
      deleteQuietly(made.uri);
      break;
    }
    if (result.draftId === null) {
      try {
        result.draftId = typeof draftId === 'string' ? draftId : await draftId();
      } catch (e) {
        deleteQuietly(made.uri);
        throw e;
      }
      if (signal.aborted) {
        deleteQuietly(made.uri);
        break;
      }
    }
    const id = result.draftId;
    const segmentId = `${id}-${Date.now()}-${index}`;
    onWriting?.(segmentId);
    const stored = await storeClip(made.uri, {
      draftId: id,
      segmentId,
      owned: true,
      signal,
      anchor: at,
    });
    if (!stored) break;
    result.added.push(segmentId);
    onAdded?.(segmentId);
  }
  result.cancelled = signal.aborted && result.added.length + result.skipped.length < total;
  importLog.info(
    `images: ${result.added.length} of ${total} added in ${formatSeconds(Date.now() - started)}` +
      (result.skipped.length ? `, ${result.skipped.length} skipped` : '') +
      (result.cancelled ? ', cancelled' : ''),
  );
  return result;
}
