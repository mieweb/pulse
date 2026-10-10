// The gestures dispatch through latest-callback refs written during render — the pattern the
// React-Compiler refs rule flags. Disabled for this file.
/* eslint-disable react-hooks/refs */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Gesture } from 'react-native-gesture-handler';
import { ReduceMotion, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { haptics } from '@/utils/haptics';

/** Press-and-hold this long on the record button to enter hold-to-record. */
const HOLD_MS = 250;
/** Vertical drag distance (px) that doubles (drag up) or halves (drag down) the zoom factor.
 * Drag-zoom is multiplicative so the feel is consistent regardless of the device's zoom range.
 * Smaller ⇒ more sensitive (less travel to double). Tuned by feel — wants an on-device pass. */
const DRAG_DOUBLING_PX = 180;
/** Pinch scale is multiplicative and VisionCamera's `zoom` is an absolute factor, so the pinch
 * scale maps onto the factor. We raise the raw scale to this exponent (>1) to make the pinch a
 * touch more sensitive than the physically-exact 1:1 (scale 2 ⇒ 2× the zoom factor at 1.0). */
const PINCH_SENSITIVITY = 1.3;

export function useRecorderGestures({
  onToggle,
  onHoldStart,
  onHoldEnd,
  onFocus,
  enabled,
  neutralZoom,
  minZoom,
  maxZoom,
}: {
  onToggle: () => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
  onFocus: (x: number, y: number) => void;
  enabled: boolean;
  /** The default/neutral zoom factor (the 1x wide lens) — opening value and flip reset target. */
  neutralZoom: number;
  /** Device's minimum zoom factor (the widest lens; 1 on devices without an ultra-wide). */
  minZoom: number;
  /** Capped maximum zoom factor we allow (see MAX_ZOOM_FACTOR in recorder.tsx). */
  maxZoom: number;
}) {
  // VisionCamera reads the `zoom` prop as a Reanimated SharedValue directly, so the gesture
  // tracks zoom per-frame with no JS round-trip or quantization. The value is an absolute zoom
  // factor in [minZoom, maxZoom]; 1 is the neutral 1x lens.
  const zoomSv = useSharedValue(1);
  const dragBase = useSharedValue(0);
  const pinchBase = useSharedValue(0);
  const holdActive = useSharedValue(false);
  // A finger is down on the record button and no hold has taken over yet — the button's
  // touch-down feedback (taps only act on release, so this is the only immediate response).
  const pressed = useSharedValue(false);
  // Mirror the device's zoom bounds into shared values so the worklets always clamp against
  // the current device (bounds change on flip / lens device).
  const minSv = useSharedValue(minZoom);
  const maxSv = useSharedValue(maxZoom);
  useEffect(() => {
    minSv.set(minZoom);
    maxSv.set(maxZoom);
  }, [minZoom, maxZoom, minSv, maxSv]);

  // The gestures are memoized but the recorder's callbacks are recreated each render —
  // dispatch through refs so a gesture never calls a stale closure over recording state.
  const onToggleRef = useRef(onToggle);
  const onHoldStartRef = useRef(onHoldStart);
  const onHoldEndRef = useRef(onHoldEnd);
  const onFocusRef = useRef(onFocus);
  onToggleRef.current = onToggle;
  onHoldStartRef.current = onHoldStart;
  onHoldEndRef.current = onHoldEnd;
  onFocusRef.current = onFocus;

  // Haptics fire before the recorder acts: they're muted while a clip records (recorder.tsx), so
  // a start haptic after capture began would never be felt, and a stop tap gives none.
  const fireToggle = useCallback(() => {
    haptics.tap();
    onToggleRef.current();
  }, []);
  const fireHoldStart = useCallback(() => {
    haptics.pickUp();
    onHoldStartRef.current();
  }, []);
  const fireHoldEnd = useCallback(() => onHoldEndRef.current(), []);
  const fireFocus = useCallback((x: number, y: number) => onFocusRef.current(x, y), []);

  const { buttonGesture, screenGesture } = useMemo(() => {
    const writeZoom = (next: number) => {
      'worklet';
      zoomSv.set(Math.min(Math.max(next, minSv.get()), maxSv.get()));
    };

    // Hold-to-record and vertical drag-zoom are ONE recognizer on the record button: the
    // long-press threshold activates it, then translationY drives zoom until release — no
    // cross-component touch coordination to race against the button.
    const holdPan = Gesture.Pan()
      .enabled(enabled)
      .activateAfterLongPress(HOLD_MS)
      // Touch-down on the button, before tap or hold has been decided.
      .onBegin(() => {
        pressed.set(true);
      })
      .onStart(() => {
        // The hold's own scale takes over from the press, in the same frame as its haptic.
        pressed.set(false);
        holdActive.set(true);
        dragBase.set(zoomSv.get());
        scheduleOnRN(fireHoldStart);
      })
      .onUpdate((e) => {
        // Finger up (negative translationY) zooms in; multiplicative so it scales with range.
        writeZoom(dragBase.get() * 2 ** (-e.translationY / DRAG_DOUBLING_PX));
      })
      .onFinalize(() => {
        pressed.set(false);
        // Fires on END and CANCELLED alike (unmount, navigation) — the stop always lands.
        if (holdActive.get()) {
          holdActive.set(false);
          scheduleOnRN(fireHoldEnd);
        }
      });

    const recordTap = Gesture.Tap()
      .enabled(enabled)
      .maxDuration(HOLD_MS) // a completed hold can never also fire the toggle
      .onEnd((_e, success) => {
        if (success) scheduleOnRN(fireToggle);
      });

    // Two-finger pinch on the preview surface, mapped multiplicatively onto the zoom factor.
    const pinch = Gesture.Pinch()
      .enabled(enabled)
      // A two-finger pinch on the preview must not cancel an in-flight hold-record.
      .simultaneousWithExternalGesture(holdPan)
      .onStart(() => {
        pinchBase.set(zoomSv.get());
      })
      .onUpdate((e) => {
        writeZoom(pinchBase.get() * e.scale ** PINCH_SENSITIVITY);
      });

    // Single-finger tap on the preview → focus to that point (tap-to-focus). One finger vs the
    // pinch's two, so they coexist; the record button owns its own taps separately.
    const focusTap = Gesture.Tap()
      .enabled(enabled)
      .maxDuration(HOLD_MS)
      .onEnd((e, success) => {
        if (success) scheduleOnRN(fireFocus, e.x, e.y);
      });

    return {
      buttonGesture: Gesture.Exclusive(holdPan, recordTap),
      screenGesture: Gesture.Simultaneous(pinch, focusTap),
    };
  }, [
    enabled,
    fireToggle,
    fireHoldStart,
    fireHoldEnd,
    fireFocus,
    zoomSv,
    dragBase,
    pinchBase,
    holdActive,
    pressed,
    minSv,
    maxSv,
  ]);

  // Reset to the neutral 1x lens — on a flip, and once when the device (and its real neutral
  // factor) first resolves, so the camera opens at 1x instead of the ultra-wide minZoom.
  const resetZoom = useCallback(() => {
    zoomSv.set(Math.min(Math.max(neutralZoom, minZoom), maxZoom));
  }, [zoomSv, neutralZoom, minZoom, maxZoom]);

  // Animate zoom to a specific factor — used by the lens chips (0.5x / 1x / Tele are zoom
  // presets). VisionCamera switches the physical camera as the factor crosses the device's
  // lens-switch boundaries, so a short timing animation gives the smooth lens transition their
  // startZoomAnimation API is meant for (a direct gesture write below cancels it, as expected).
  // Runs under Reduce Motion too: it's the camera moving between lenses, not UI decoration, and
  // a jump would make the lens switch itself abrupt.
  const setZoomTo = useCallback(
    (factor: number) => {
      zoomSv.set(
        withTiming(Math.min(Math.max(factor, minZoom), maxZoom), {
          duration: 220,
          reduceMotion: ReduceMotion.Never,
        }),
      );
    },
    [zoomSv, minZoom, maxZoom],
  );

  return { zoomSv, holdActive, pressed, buttonGesture, screenGesture, resetZoom, setZoomTo };
}
