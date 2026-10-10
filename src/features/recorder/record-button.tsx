import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { GestureDetector, type ComposedGesture } from 'react-native-gesture-handler';
import Animated, {
  cubicBezier,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { Accent } from '@/constants/theme';
import { EaseOut } from '@/constants/motion';
import { RECORD_BUTTON_SIZE } from '@/features/recorder/track-metrics';

const INNER_SIZE = 60;
/** Touch-down squeeze of the inner disc, so the button answers the finger before tap or hold
 *  has been decided. */
const PRESS_SCALE = 0.92;
const PRESS_MS = 100;
/** Recording: the 60 pt disc becomes a 30 pt rounded square (radius 16 at full size renders 8
 *  at half size). One fixed-size view scaled, so the morph never changes layout. */
const RECORDING_SCALE = 0.5;
const RECORDING_RADIUS = 16;
const MORPH_MS = 180;
/** Hold-to-record: the ring grows and the disc shrinks; release settles a little faster. */
const HOLD_RING_SCALE = 1.15;
const HOLD_INNER_SCALE = 0.75;
const HOLD_IN_MS = 150;
const HOLD_OUT_MS = 120;

/**
 * The record controls fade out while a clip is dragged (the trash takes their place) and back
 * when it's dropped — one timing for every piece so they leave and return together. EaseOut as a
 * CSS timing function, so a React state flip animates without a shared value per control.
 */
export const CONTROLS_FADE = {
  transitionProperty: 'opacity',
  transitionDuration: 150,
  transitionTimingFunction: cubicBezier(0.23, 1, 0.32, 1),
} as const;

/**
 * The record button — render and press / hold / recording feedback only. All touch handling
 * (tap-to-toggle, hold-to-record, drag-zoom) lives in the composed gesture from
 * useRecorderGestures. The animations are feedback: recording starts and stops on the gesture,
 * never waiting for them.
 */
export function RecordButton({
  gesture,
  holdActive,
  pressed,
  isRecording,
  cameraReady,
  dragging,
}: {
  gesture: ComposedGesture;
  holdActive: SharedValue<boolean>;
  pressed: SharedValue<boolean>;
  isRecording: boolean;
  cameraReady: boolean;
  dragging: boolean;
}) {
  // Each state animates its own 0→1 progress and the styles multiply them, so a press, a hold
  // and the recording morph can overlap without one transform cancelling another.
  const press = useSharedValue(0);
  const hold = useSharedValue(0);
  const recording = useSharedValue(isRecording ? 1 : 0);
  useAnimatedReaction(
    () => pressed.get(),
    (down, prev) => {
      if (down !== prev)
        press.set(withTiming(down ? 1 : 0, { duration: PRESS_MS, easing: EaseOut }));
    },
  );
  useAnimatedReaction(
    () => holdActive.get(),
    (active, prev) => {
      if (active === prev) return;
      hold.set(
        withTiming(active ? 1 : 0, {
          duration: active ? HOLD_IN_MS : HOLD_OUT_MS,
          easing: EaseOut,
        }),
      );
    },
  );
  useEffect(() => {
    recording.set(withTiming(isRecording ? 1 : 0, { duration: MORPH_MS, easing: EaseOut }));
  }, [isRecording, recording]);

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + (HOLD_RING_SCALE - 1) * hold.get() }],
  }));
  const innerStyle = useAnimatedStyle(() => {
    const r = recording.get();
    const scale =
      (1 - (1 - PRESS_SCALE) * press.get()) *
      (1 - (1 - HOLD_INNER_SCALE) * hold.get()) *
      (1 - (1 - RECORDING_SCALE) * r);
    return {
      borderRadius: INNER_SIZE / 2 - (INNER_SIZE / 2 - RECORDING_RADIUS) * r,
      transform: [{ scale }],
    };
  });

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessibilityRole="button"
        accessibilityLabel={isRecording ? 'Stop recording' : 'Start recording'}
        style={[CONTROLS_FADE, { opacity: dragging ? 0 : cameraReady ? 1 : 0.35 }]}>
        <Animated.View style={[styles.recordOuter, ringStyle]}>
          <Animated.View style={[styles.recordInner, innerStyle]} />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  recordOuter: {
    width: RECORD_BUTTON_SIZE,
    height: RECORD_BUTTON_SIZE,
    borderRadius: RECORD_BUTTON_SIZE / 2,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordInner: {
    width: INNER_SIZE,
    height: INNER_SIZE,
    borderRadius: INNER_SIZE / 2,
    backgroundColor: Accent,
  },
});
