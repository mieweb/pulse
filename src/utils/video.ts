import { File } from 'expo-file-system';
import { createVideoPlayer, VideoThumbnail } from 'expo-video';
import { probe, thumbnail } from '@mieweb/pulse-editor';

import { toFileUri } from './file-store';
import { parseEdit } from './segment-window';

type Player = ReturnType<typeof createVideoPlayer>;

/** Resolves once the player is ready to read metadata / frames (or errors / times out). */
function whenReady(player: Player): Promise<void> {
  return new Promise((resolve) => {
    if (player.status === 'readyToPlay') return resolve();
    const done = () => {
      clearTimeout(timer);
      sub.remove();
      resolve();
    };
    const sub = player.addListener('statusChange', ({ status }) => {
      if (status === 'readyToPlay' || status === 'error') done();
    });
    const timer = setTimeout(done, 5000);
  });
}

/** A clip's cover frame as a jpeg (`file://`, in the cache): the first frame, or the frame at an
 * edit's start, rotated / flipped / cropped as the export renders it. */
async function coverFrame(videoAbsUri: string, editState?: string): Promise<string> {
  const parsed = parseEdit(editState);
  const frame = await thumbnail(videoAbsUri, {
    timeMs: parsed?.startMs ?? 0,
    quality: 0.8,
    maxWidth: 192,
    maxHeight: 256,
    // The editor stores counter-clockwise quarter turns; pulse-editor takes clockwise degrees.
    rotation: parsed ? ((4 - parsed.rotation) % 4) * 90 : 0,
    flipped: parsed?.flipped ?? false,
    crop: parsed?.crop ?? undefined,
  });
  return toFileUri(frame.uri);
}

/**
 * Extract a clip's cover frame (see `coverFrame`) and move it to `destAbsUri` (its persisted home
 * in the draft dir). Returns false on failure, leaving the caller to store a null thumbnail (the
 * runtime `generateThumbnail` fallback then covers it, edit included).
 */
export async function generateThumbnailFile(
  videoAbsUri: string,
  destAbsUri: string,
  edit?: { editState: string; startMs: number },
): Promise<boolean> {
  try {
    const frame = await coverFrame(videoAbsUri, edit?.editState);
    const dest = new File(destAbsUri);
    if (dest.exists) dest.delete();
    await new File(frame).move(dest);
    return true;
  } catch (e) {
    console.warn('[video] thumbnail file failed for', videoAbsUri, e);
    return false;
  }
}

// VideoThumbnail is a native SharedRef with no file URI. Fallback for rows with no persisted
// cover (null `thumbnail` column): persisted before disk thumbnails existed, or whose cover
// failed to render. Cached by uri (and edit), the oldest dropped past a bound.
const thumbnailCache = new Map<string, VideoThumbnail | { uri: string }>();
const THUMBNAIL_CACHE_LIMIT = 64;

function cacheThumbnail(key: string, thumb: VideoThumbnail | { uri: string }) {
  if (thumbnailCache.size >= THUMBNAIL_CACHE_LIMIT) {
    const oldest = thumbnailCache.keys().next().value;
    if (oldest !== undefined) thumbnailCache.delete(oldest);
  }
  thumbnailCache.set(key, thumb);
}

/**
 * A clip's cover when it has no persisted one, cached: the first frame, or for an edited clip
 * (`editState`) its edited frame. Undefined on failure, so an edited clip shows no cover rather
 * than its unedited first frame.
 */
export async function generateThumbnail(
  uri: string,
  editState?: string | null,
): Promise<VideoThumbnail | { uri: string } | undefined> {
  const key = editState ? `${uri}#${editState}` : uri;
  const cached = thumbnailCache.get(key);
  if (cached) return cached;

  if (editState && parseEdit(editState)) {
    try {
      const thumb = { uri: await coverFrame(uri, editState) };
      cacheThumbnail(key, thumb);
      return thumb;
    } catch (e) {
      console.warn('[video] edited thumbnail failed for', uri, e);
      return undefined;
    }
  }

  let player: Player | undefined;
  try {
    player = createVideoPlayer(uri);
    await whenReady(player);
    const thumbs = await player.generateThumbnailsAsync(0, { maxWidth: 96, maxHeight: 128 });
    const thumb = thumbs[0];
    if (thumb) cacheThumbnail(key, thumb);
    return thumb;
  } catch (e) {
    console.warn('[video] thumbnail failed for', uri, e);
    return undefined;
  } finally {
    player?.release();
  }
}

/**
 * A clip's length in ms via pulse-editor's `probe` (no player to spin up): its picture's, since
 * the file's own length is its longest track's and sound can outlast the last frame. The file's
 * length stands in when the video track reports none. 0 for a file with no picture or one that
 * can't be read (the clip is then skipped on playback and merge).
 */
export async function getDurationMs(uri: string): Promise<number> {
  try {
    const { durationMs, video } = await probe(uri);
    if (!video) return 0;
    const ms = video.durationMs > 0 ? video.durationMs : durationMs;
    return ms > 0 ? ms : 0;
  } catch (e) {
    console.warn('[video] duration failed for', uri, e);
    return 0;
  }
}
