import { useEffect } from 'react';
import { useSharedValue } from 'react-native-reanimated';

import type { CaptionStyle } from './caption-style';
import { SkiaCaption } from './skia-caption';
import type { TranscriptLine } from './whisper';

type Props = {
  /** Effective caption lines (centiseconds), sorted by start. */
  lines: readonly TranscriptLine[];
  /** Current playback position in milliseconds, in the same time base as `lines`. */
  positionMs: number;
  style: CaptionStyle;
  /** The picture's size, dp. */
  width: number;
  height: number;
};

/**
 * The captions over a player whose time comes as a value (expo-video's `timeUpdate`), drawn as
 * the editor draws them (skia-caption.tsx), where they were placed. Shows only; nothing to touch.
 */
export function CaptionOverlay({ lines, positionMs, style, width, height }: Props) {
  const timeMs = useSharedValue(positionMs);
  useEffect(() => {
    timeMs.set(positionMs);
  }, [positionMs, timeMs]);
  if (width <= 0 || height <= 0) return null;
  return (
    <SkiaCaption lines={lines} timeMs={timeMs} style={style} width={width} height={height} />
  );
}
