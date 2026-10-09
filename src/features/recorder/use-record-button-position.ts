// Gesture callbacks and measure callbacks imperatively drive shared values and refs by
// design — same situation as use-recorder-gestures.ts.
/* eslint-disable react-hooks/immutability, react-hooks/refs */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutChangeEvent, View } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { Spacing } from '@/constants/theme';
import { deleteSetting, getSetting, RECORD_BUTTON_POSITION_KEY, setSetting } from '@/db/settings';
import { MOVE_HANDLE_SIZE } from '@/features/recorder/move-handle';
import {
  centerBounds,
  clampCenter,
  parsePosition,
  type Point,
  serializePosition,
} from '@/features/recorder/record-button-position';
import { RECORD_BUTTON_SIZE } from '@/features/recorder/track-metrics';

/** Gap between the move handle and the record button. */
export const MOVE_HANDLE_GAP = Spacing.two;
const EDGE_MARGIN = Spacing.two;
type Size = { width: number; height: number };

/**
 * The user-movable record button (#231). The button's default ("home") spot is a placeholder
 * in the normal bottom layout; the real button + move handle float over the whole overlay
 * (so they stay touchable anywhere — Android drops touches outside a parent's bounds) and are
 * placed at home + the user's drag offset. The chosen spot persists as screen fractions.
 *
 * Wire up: `overlayRef`/`onOverlayLayout` on the full-screen overlay, `homeRef`/`remeasure` on
 * the placeholder (and `remeasure` on any ancestor whose move would shift it), `groupStyle` on
 * the floating group, `handleGesture` on the move handle.
 */
export function useRecordButtonPosition({
  insets,
  topReserved,
  enabled,
}: {
  insets: { top: number; bottom: number; left: number; right: number };
  /** Height reserved at the top of the screen (the top bar) that the button can't cover. */
  topReserved: number;
  enabled: boolean;
}) {
  const overlayRef = useRef<View>(null);
  const homeRef = useRef<View>(null);
  const [screen, setScreen] = useState<Size | null>(null);
  const [home, setHome] = useState<Point | null>(null);
  // Persisted spot as screen fractions; null = the default home spot.
  const [stored, setStored] = useState<Point | null>(null);
  // Set once the user moves/resets — a slow initial read must not clobber that.
  const touchedRef = useRef(false);
  const screenRef = useRef<Size | null>(null);
  screenRef.current = screen;

  const homeSv = useSharedValue<Point | null>(null);
  const boundsSv = useSharedValue<ReturnType<typeof centerBounds> | null>(null);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const dragStart = useSharedValue<Point>({ x: 0, y: 0 });

  useEffect(() => {
    let cancelled = false;
    getSetting(RECORD_BUTTON_POSITION_KEY)
      .then((raw) => {
        if (!cancelled && !touchedRef.current) setStored(parsePosition(raw));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const remeasure = useCallback(() => {
    const overlay = overlayRef.current;
    const node = homeRef.current;
    if (!overlay || !node) return;
    node.measureLayout(
      overlay,
      (left, top, width, height) => {
        const next = { x: left + width / 2, y: top + height / 2 };
        // Written before the state update so the group's first frame is already in place.
        homeSv.value = next;
        setHome((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
      },
      () => {},
    );
  }, [homeSv]);

  const onOverlayLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      setScreen((prev) =>
        prev && prev.width === width && prev.height === height ? prev : { width, height },
      );
      remeasure();
    },
    [remeasure],
  );

  const bounds = useMemo(
    () =>
      screen &&
      centerBounds({
        screen,
        insets,
        topReserved,
        buttonSize: RECORD_BUTTON_SIZE,
        leftExtent: MOVE_HANDLE_SIZE + MOVE_HANDLE_GAP,
        margin: EDGE_MARGIN,
      }),
    [screen, insets, topReserved],
  );

  // Resolve the stored spot against the current screen/home (re-clamped, so a spot saved on a
  // bigger screen or with a different layout still lands fully visible).
  useEffect(() => {
    if (!home || !bounds || !screen) return;
    boundsSv.value = bounds;
    const target = stored
      ? clampCenter({ x: stored.x * screen.width, y: stored.y * screen.height }, bounds)
      : home;
    tx.value = target.x - home.x;
    ty.value = target.y - home.y;
  }, [home, bounds, screen, stored, boundsSv, tx, ty]);

  const save = useCallback((x: number, y: number) => {
    const size = screenRef.current;
    if (!size) return;
    touchedRef.current = true;
    const raw = serializePosition({ x, y }, size);
    setStored(parsePosition(raw));
    void setSetting(RECORD_BUTTON_POSITION_KEY, raw);
  }, []);

  const reset = useCallback(() => {
    touchedRef.current = true;
    tx.value = 0;
    ty.value = 0;
    setStored(null);
    void deleteSetting(RECORD_BUTTON_POSITION_KEY);
  }, [tx, ty]);

  const handleGesture = useMemo(() => {
    const pan = Gesture.Pan()
      .enabled(enabled)
      .onStart(() => {
        const h = homeSv.value;
        if (!h) return;
        dragStart.value = { x: h.x + tx.value, y: h.y + ty.value };
      })
      .onUpdate((e) => {
        const h = homeSv.value;
        const b = boundsSv.value;
        if (!h || !b) return;
        const c = clampCenter(
          { x: dragStart.value.x + e.translationX, y: dragStart.value.y + e.translationY },
          b,
        );
        tx.value = c.x - h.x;
        ty.value = c.y - h.y;
      })
      .onEnd(() => {
        const h = homeSv.value;
        if (!h || !boundsSv.value) return;
        runOnJS(save)(h.x + tx.value, h.y + ty.value);
      });
    const resetTap = Gesture.Tap()
      .enabled(enabled)
      .numberOfTaps(2)
      .onEnd((_e, success) => {
        if (success) runOnJS(reset)();
      });
    return Gesture.Race(pan, resetTap);
  }, [enabled, homeSv, boundsSv, tx, ty, dragStart, save, reset]);

  // The floating group is [handle, gap, button], absolutely placed at the overlay origin and
  // translated so the button's centre sits on home + offset.
  const groupStyle = useAnimatedStyle(() => {
    const h = homeSv.value ?? { x: 0, y: 0 };
    return {
      transform: [
        {
          translateX: h.x - MOVE_HANDLE_SIZE - MOVE_HANDLE_GAP - RECORD_BUTTON_SIZE / 2 + tx.value,
        },
        { translateY: h.y - RECORD_BUTTON_SIZE / 2 + ty.value },
      ],
    };
  });

  return {
    overlayRef,
    homeRef,
    /** True once the home spot is measured — render the floating group only after that. */
    ready: home != null,
    onOverlayLayout,
    remeasure,
    groupStyle,
    handleGesture,
  };
}
