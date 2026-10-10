import type { RefObject } from 'react';
import { useCallback } from 'react';
import {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import type { CameraRef } from 'react-native-vision-camera';

import { EaseOut } from '@/constants/motion';

// The fade runs under Reduce Motion too: a fade isn't motion, and the system default would
// finish the whole sequence at once, so the reticle would never show.
const FADE = { easing: EaseOut, reduceMotion: ReduceMotion.Never };

/** Side length of the square focus reticle. */
export const RETICLE_SIZE = 52;

/**
 * Tap-to-focus reticle. Returns an `onFocus(x, y)` to call on a preview tap — it meters the
 * camera to that point AND punches a reticle in there that fades out (~1s) — plus the animated
 * style to spread onto the reticle view.
 *
 * Follows VisionCamera's focus guidance: skipped when the device can't meter
 * (`supportsFocusMetering`), and metered "steady" while filming (least intrusive in the
 * recording) vs "snappy" while just framing.
 */
export function useFocusReticle({
  cameraRef,
  supportsFocus,
  isRecording,
}: {
  cameraRef: RefObject<CameraRef | null>;
  supportsFocus: boolean;
  isRecording: boolean;
}) {
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(1);

  const onFocus = useCallback(
    (px: number, py: number) => {
      if (!supportsFocus) return;
      x.set(px);
      y.set(py);
      scale.set(
        withSequence(
          withTiming(1.25, { duration: 0 }),
          withTiming(1, { duration: 220, easing: EaseOut }),
        ),
      );
      opacity.set(
        withSequence(
          withTiming(1, { duration: 120, ...FADE }),
          withTiming(1, { duration: 550, ...FADE }),
          withTiming(0, { duration: 300, ...FADE }),
        ),
      );
      void cameraRef.current
        ?.focusTo({ x: px, y: py }, { responsiveness: isRecording ? 'steady' : 'snappy' })
        .catch(() => {});
    },
    [cameraRef, supportsFocus, isRecording, x, y, opacity, scale],
  );

  const reticleStyle = useAnimatedStyle(() => ({
    opacity: opacity.get(),
    transform: [
      { translateX: x.get() - RETICLE_SIZE / 2 },
      { translateY: y.get() - RETICLE_SIZE / 2 },
      { scale: scale.get() },
    ],
  }));

  return { onFocus, reticleStyle };
}
