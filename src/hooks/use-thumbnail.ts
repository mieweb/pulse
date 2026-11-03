import { VideoThumbnail } from 'expo-video';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { absolutize } from '@/utils/file-store';
import {
  cachedThumbnail,
  coverInFlight,
  coverSeen,
  generateThumbnail,
  subscribeCoversInFlight,
} from '@/utils/video';

type Thumb = { uri: string } | VideoThumbnail | undefined;

/**
 * Cover frame for a stored clip. Prefers the persisted jpeg (`thumbRel`, written at record/edit
 * time) rendered straight from disk — no player. Without one (rows persisted before disk
 * thumbnails existed, or a cover that failed to render) it's extracted at runtime from
 * `videoRelFallback`, with `editState` applied when the clip has an edit stored as settings.
 * A clip just recorded has no cover until it's made, a moment after its row (`addSegmentCover`):
 * it waits for that rather than extracting one itself.
 * `undefined` while the fallback loads or when there is nothing to show.
 */
export function useThumbnail(
  thumbRel?: string | null,
  videoRelFallback?: string | null,
  editState?: string | null,
): Thumb {
  // Kept with the clip and edit it's for, so a changed edit never shows the previous frame.
  const key = `${videoRelFallback ?? ''}#${editState ?? ''}`;
  // A frame already extracted (generateThumbnail's bounded cache) shows on the first render, so a
  // copy mounted later (a dragged clip's) doesn't start blank.
  const [fallback, setFallback] = useState<{ key: string; thumb: Thumb } | undefined>(() => {
    const hit = videoRelFallback
      ? cachedThumbnail(absolutize(videoRelFallback), editState)
      : undefined;
    return hit ? { key, thumb: hit } : undefined;
  });
  const shown = fallback?.key === key;
  const coverComing = useSyncExternalStore(subscribeCoversInFlight, () =>
    videoRelFallback ? coverInFlight(absolutize(videoRelFallback)) : false,
  );

  useEffect(() => {
    if (thumbRel && videoRelFallback) coverSeen(absolutize(videoRelFallback));
    if (thumbRel || !videoRelFallback || shown || coverComing) return;
    let alive = true;
    void generateThumbnail(absolutize(videoRelFallback), editState).then((thumb) => {
      if (alive) setFallback({ key, thumb });
    });
    return () => {
      alive = false;
    };
  }, [thumbRel, videoRelFallback, editState, key, shown, coverComing]);

  if (thumbRel) return { uri: absolutize(thumbRel) };
  return videoRelFallback && fallback?.key === key ? fallback.thumb : undefined;
}
