import { VideoThumbnail } from 'expo-video';
import { useEffect, useState } from 'react';

import { absolutize } from '@/utils/file-store';
import { generateThumbnail } from '@/utils/video';

type Thumb = { uri: string } | VideoThumbnail | undefined;

/** Frames already extracted, by clip and edit: a copy mounted later (a dragged clip's) has its
 * frame on its first render instead of starting blank. */
const extracted = new Map<string, Thumb>();

/**
 * Cover frame for a stored clip. Prefers the persisted jpeg (`thumbRel`, written at record/edit
 * time) rendered straight from disk — no player. Without one (rows persisted before disk
 * thumbnails existed, or a cover that failed to render) it's extracted at runtime from
 * `videoRelFallback`, with `editState` applied when the clip has an edit stored as settings.
 * `undefined` while the fallback loads or when there is nothing to show.
 */
export function useThumbnail(
  thumbRel?: string | null,
  videoRelFallback?: string | null,
  editState?: string | null,
): Thumb {
  // Kept with the clip and edit it's for, so a changed edit never shows the previous frame.
  const key = `${videoRelFallback ?? ''}#${editState ?? ''}`;
  const [fallback, setFallback] = useState<{ key: string; thumb: Thumb } | undefined>(() => {
    const hit = extracted.get(key);
    return hit ? { key, thumb: hit } : undefined;
  });
  const shown = fallback?.key === key;

  useEffect(() => {
    if (thumbRel || !videoRelFallback || shown) return;
    let alive = true;
    const hit = extracted.get(key);
    void (
      hit ? Promise.resolve(hit) : generateThumbnail(absolutize(videoRelFallback), editState)
    ).then((thumb) => {
      if (thumb) extracted.set(key, thumb);
      if (alive) setFallback({ key, thumb });
    });
    return () => {
      alive = false;
    };
  }, [thumbRel, videoRelFallback, editState, key, shown]);

  if (thumbRel) return { uri: absolutize(thumbRel) };
  return videoRelFallback && fallback?.key === key ? fallback.thumb : undefined;
}
