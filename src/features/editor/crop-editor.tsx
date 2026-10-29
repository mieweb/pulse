import { thumbnail } from '@mieweb/pulse-editor';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import { Accent } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { ClipCrop } from '@/utils/segment-window';
import { haptics } from '@/utils/haptics';

import { clamp, normalizedCrop } from './timeline-geometry';

const MIN_SIDE = 60;
const GRAB = 30;
const BRACKET = 20;
const BRACKET_THICK = 4;

/** Aspect presets, width / height (0 = free). */
const ASPECTS: { label: string; ratio: number }[] = [
  { label: 'Free', ratio: 0 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '1:1', ratio: 1 },
  { label: '16:9', ratio: 16 / 9 },
];

type Rect = { x: number; y: number; w: number; h: number };

type Zone = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
// 0 none, 1 move, 2 tl, 3 tr, 4 bl, 5 br, 6 left, 7 right, 8 top, 9 bottom

type Props = {
  uri: string;
  /** Clockwise degrees and the mirror, as the merge takes them. */
  rotation: number;
  flipped: boolean;
  /** The source time whose frame to crop on. */
  timeMs: number;
  crop: ClipCrop | null;
  onCancel: () => void;
  onDone: (crop: ClipCrop | null) => void;
};

/**
 * Crop mode, over the editor: the clip's frame with its rotate and flip (not its crop), and a
 * crop box to drag by a corner, an edge or the middle, or to pinch: a border, thirds,
 * L-shaped corner brackets, edge bars and a 60 pt minimum, plus aspect presets and a dim
 * outside the box. The crop is normalized to the displayed frame; Done stores it.
 */
export function CropEditor({ uri, rotation, flipped, timeMs, crop, onCancel, onDone }: Props) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const [frame, setFrame] = useState<{ uri: string; width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [aspect, setAspect] = useState(0);

  useEffect(() => {
    let live = true;
    thumbnail(uri, { timeMs, maxWidth: 1080, maxHeight: 1920, rotation, flipped })
      .then((t) => live && setFrame(t))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [uri, timeMs, rotation, flipped]);

  // The frame as displayed: fitted (contain) in the stage, with a margin for the brackets.
  const pad = BRACKET_THICK + 6;
  const image: Rect | null = (() => {
    if (!frame || stage.width <= 0 || stage.height <= 0) return null;
    const sw = stage.width - pad * 2;
    const sh = stage.height - pad * 2;
    const k = Math.min(sw / frame.width, sh / frame.height);
    const w = frame.width * k;
    const h = frame.height * k;
    return { x: pad + (sw - w) / 2, y: pad + (sh - h) / 2, w, h };
  })();

  const img = useSharedValue<Rect>({ x: 0, y: 0, w: 1, h: 1 });
  const box = useSharedValue<Rect>({ x: 0, y: 0, w: 1, h: 1 });
  const start = useSharedValue<Rect>({ x: 0, y: 0, w: 1, h: 1 });
  const zone = useSharedValue<Zone>(0);
  const ratio = useSharedValue(0);
  const scale0 = useSharedValue<Rect>({ x: 0, y: 0, w: 1, h: 1 });
  const guides = useSharedValue(0);
  // The box as JS last saw it (gesture ends, presets), so Done needn't read the UI thread; null
  // until it moves (the saved crop).
  const [boxJs, setBoxJs] = useState<Rect | null>(null);

  // Place the box when the frame is first laid out: the saved crop, or the whole frame.
  const placed = useRef(false);
  useEffect(() => {
    if (!image || placed.current) return;
    placed.current = true;
    img.set(image);
    const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
    box.set({
      x: image.x + c.x * image.w,
      y: image.y + c.y * image.h,
      w: c.w * image.w,
      h: c.h * image.h,
    });
  }, [image, crop, img, box]);

  const [gesture] = useState(() => {
    const pan = Gesture.Pan()
      .minDistance(0)
      .onStart((e) => {
        const b = box.get();
        const nearL = Math.abs(e.x - b.x) < GRAB;
        const nearR = Math.abs(e.x - (b.x + b.w)) < GRAB;
        const nearT = Math.abs(e.y - b.y) < GRAB;
        const nearB = Math.abs(e.y - (b.y + b.h)) < GRAB;
        const inX = e.x > b.x - GRAB && e.x < b.x + b.w + GRAB;
        const inY = e.y > b.y - GRAB && e.y < b.y + b.h + GRAB;
        let z: Zone = 0;
        if (nearT && nearL) z = 2;
        else if (nearT && nearR) z = 3;
        else if (nearB && nearL) z = 4;
        else if (nearB && nearR) z = 5;
        else if (ratio.get() === 0 && nearL && inY) z = 6;
        else if (ratio.get() === 0 && nearR && inY) z = 7;
        else if (ratio.get() === 0 && nearT && inX) z = 8;
        else if (ratio.get() === 0 && nearB && inX) z = 9;
        else if (e.x > b.x && e.x < b.x + b.w && e.y > b.y && e.y < b.y + b.h) z = 1;
        zone.set(z);
        start.set(b);
        guides.set(z === 0 ? 0 : 1);
      })
      .onUpdate((e) => {
        const z = zone.get();
        if (z === 0) return;
        const s = start.get();
        const im = img.get();
        const dx = e.translationX;
        const dy = e.translationY;
        if (z === 1) {
          box.set({
            x: clamp(s.x + dx, im.x, im.x + im.w - s.w),
            y: clamp(s.y + dy, im.y, im.y + im.h - s.h),
            w: s.w,
            h: s.h,
          });
          return;
        }
        let x0 = s.x;
        let y0 = s.y;
        let x1 = s.x + s.w;
        let y1 = s.y + s.h;
        if (z === 2 || z === 4 || z === 6) x0 = clamp(s.x + dx, im.x, x1 - MIN_SIDE);
        if (z === 3 || z === 5 || z === 7) x1 = clamp(s.x + s.w + dx, x0 + MIN_SIDE, im.x + im.w);
        if (z === 2 || z === 3 || z === 8) y0 = clamp(s.y + dy, im.y, y1 - MIN_SIDE);
        if (z === 4 || z === 5 || z === 9) y1 = clamp(s.y + s.h + dy, y0 + MIN_SIDE, im.y + im.h);
        const r = ratio.get();
        if (r > 0) {
          // Corners keep the aspect: the width leads, the height follows from the fixed corner,
          // and both shrink together if that runs off the frame.
          let w = x1 - x0;
          let h = w / r;
          const top = z === 2 || z === 3;
          const left = z === 2 || z === 4;
          const room = top ? s.y + s.h - im.y : im.y + im.h - s.y;
          if (h > room) {
            h = room;
            w = h * r;
          }
          if (left) x0 = x1 - w;
          else x1 = x0 + w;
          if (top) {
            y1 = s.y + s.h;
            y0 = y1 - h;
          } else {
            y0 = s.y;
            y1 = y0 + h;
          }
        }
        box.set({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      })
      .onFinalize(() => {
        if (zone.get() === 0) return;
        zone.set(0);
        guides.set(0);
        scheduleOnRN(setBoxJs, box.get());
      });

    const pinch = Gesture.Pinch()
      .onStart(() => {
        scale0.set(box.get());
        guides.set(1);
      })
      .onUpdate((e) => {
        const s = scale0.get();
        const im = img.get();
        const cx = s.x + s.w / 2;
        const cy = s.y + s.h / 2;
        // Same factor on both sides (the aspect holds), within the frame and the minimum.
        const k = clamp(
          e.scale,
          Math.max(MIN_SIDE / s.w, MIN_SIDE / s.h),
          Math.min(im.w / s.w, im.h / s.h),
        );
        const w = s.w * k;
        const h = s.h * k;
        box.set({
          x: clamp(cx - w / 2, im.x, im.x + im.w - w),
          y: clamp(cy - h / 2, im.y, im.y + im.h - h),
          w,
          h,
        });
      })
      .onFinalize(() => {
        guides.set(0);
        scheduleOnRN(setBoxJs, box.get());
      });
    return Gesture.Simultaneous(pan, pinch);
  });

  const pickAspect = (r: number) => {
    haptics.tap();
    setAspect(r);
    ratio.set(r);
    if (!image || r === 0) return;
    // The largest box of that aspect, centred on the frame.
    let w = image.w;
    let h = w / r;
    if (h > image.h) {
      h = image.h;
      w = h * r;
    }
    const next = { x: image.x + (image.w - w) / 2, y: image.y + (image.h - h) / 2, w, h };
    box.set(next);
    setBoxJs(next);
  };

  const reset = () => {
    haptics.tap();
    setAspect(0);
    ratio.set(0);
    if (!image) return;
    box.set(image);
    setBoxJs(image);
  };

  const done = () => {
    if (!image) return onCancel();
    if (!boxJs) return onDone(crop);
    const b = boxJs;
    onDone(
      normalizedCrop({
        x: (b.x - image.x) / image.w,
        y: (b.y - image.y) / image.h,
        w: b.w / image.w,
        h: b.h / image.h,
      }),
    );
  };

  const boxStyle = useAnimatedStyle(() => {
    const b = box.get();
    return { left: b.x, top: b.y, width: b.w, height: b.h };
  });
  const gridStyle = useAnimatedStyle(() => ({ opacity: guides.get() ? 1 : 0.35 }));
  const dimTop = useAnimatedStyle(() => {
    const b = box.get();
    return { left: 0, right: 0, top: 0, height: b.y };
  });
  const dimBottom = useAnimatedStyle(() => {
    const b = box.get();
    return { left: 0, right: 0, top: b.y + b.h, bottom: 0 };
  });
  const dimLeft = useAnimatedStyle(() => {
    const b = box.get();
    return { left: 0, width: b.x, top: b.y, height: b.h };
  });
  const dimRight = useAnimatedStyle(() => {
    const b = box.get();
    return { left: b.x + b.w, right: 0, top: b.y, height: b.h };
  });

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top, paddingBottom: insets.bottom, backgroundColor: theme.background },
      ]}>
      <View style={styles.header}>
        <Pressable onPress={onCancel} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.headerButton, { color: theme.text }]}>Cancel</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.text }]}>Crop</Text>
        <Pressable onPress={done} hitSlop={8} accessibilityRole="button" disabled={!image}>
          <Text style={[styles.headerButton, styles.headerDone]}>Done</Text>
        </Pressable>
      </View>
      <GestureDetector gesture={gesture}>
        <View
          style={styles.stage}
          onLayout={(e) =>
            setStage({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })
          }>
          {image && frame && (
            <>
              <Image
                source={frame.uri}
                style={{
                  position: 'absolute',
                  left: image.x,
                  top: image.y,
                  width: image.w,
                  height: image.h,
                }}
                contentFit="fill"
                transition={0}
              />
              <Animated.View style={[styles.dim, dimTop]} pointerEvents="none" />
              <Animated.View style={[styles.dim, dimBottom]} pointerEvents="none" />
              <Animated.View style={[styles.dim, dimLeft]} pointerEvents="none" />
              <Animated.View style={[styles.dim, dimRight]} pointerEvents="none" />
              <Animated.View style={[styles.box, boxStyle]} pointerEvents="none">
                <Animated.View style={[StyleSheet.absoluteFill, gridStyle]}>
                  <View style={[styles.gridV, { left: '33.33%' }]} />
                  <View style={[styles.gridV, { left: '66.66%' }]} />
                  <View style={[styles.gridH, { top: '33.33%' }]} />
                  <View style={[styles.gridH, { top: '66.66%' }]} />
                </Animated.View>
                <View style={[styles.bracketH, { top: -BRACKET_THICK, left: -BRACKET_THICK }]} />
                <View style={[styles.bracketV, { top: -BRACKET_THICK, left: -BRACKET_THICK }]} />
                <View style={[styles.bracketH, { top: -BRACKET_THICK, right: -BRACKET_THICK }]} />
                <View style={[styles.bracketV, { top: -BRACKET_THICK, right: -BRACKET_THICK }]} />
                <View style={[styles.bracketH, { bottom: -BRACKET_THICK, left: -BRACKET_THICK }]} />
                <View style={[styles.bracketV, { bottom: -BRACKET_THICK, left: -BRACKET_THICK }]} />
                <View
                  style={[styles.bracketH, { bottom: -BRACKET_THICK, right: -BRACKET_THICK }]}
                />
                <View
                  style={[styles.bracketV, { bottom: -BRACKET_THICK, right: -BRACKET_THICK }]}
                />
                {aspect === 0 && (
                  <>
                    <View style={[styles.edgeH, { top: -BRACKET_THICK }]} />
                    <View style={[styles.edgeH, { bottom: -BRACKET_THICK }]} />
                    <View style={[styles.edgeV, { left: -BRACKET_THICK }]} />
                    <View style={[styles.edgeV, { right: -BRACKET_THICK }]} />
                  </>
                )}
              </Animated.View>
            </>
          )}
          {!frame && !failed && <ActivityIndicator color="#fff" />}
          {failed && (
            <Text style={[styles.failed, { color: theme.textSecondary }]}>
              Couldn’t load this frame.
            </Text>
          )}
        </View>
      </GestureDetector>
      <View style={styles.bottom}>
        {ASPECTS.map((a) => {
          const on = aspect === a.ratio;
          return (
            <Pressable
              key={a.label}
              onPress={() => pickAspect(a.ratio)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[styles.chip, { backgroundColor: on ? theme.text : theme.backgroundElement }]}>
              <Text style={[styles.chipText, { color: on ? theme.background : theme.text }]}>
                {a.label}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={reset}
          accessibilityRole="button"
          style={[styles.chip, { backgroundColor: theme.backgroundElement }]}>
          <Text style={[styles.chipText, { color: theme.text }]}>Reset</Text>
        </Pressable>
      </View>
    </View>
  );
}

const LINE = 'rgba(255,255,255,0.9)';

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  header: {
    height: 48,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerButton: { fontSize: 17 },
  headerDone: { fontWeight: '600', color: Accent },
  title: { fontSize: 17, fontWeight: '600' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dim: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  box: { position: 'absolute', borderWidth: 1, borderColor: LINE },
  gridV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: LINE,
  },
  gridH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: LINE,
  },
  bracketH: {
    position: 'absolute',
    width: BRACKET,
    height: BRACKET_THICK,
    borderRadius: 2,
    backgroundColor: '#fff',
  },
  bracketV: {
    position: 'absolute',
    width: BRACKET_THICK,
    height: BRACKET,
    borderRadius: 2,
    backgroundColor: '#fff',
  },
  edgeH: {
    position: 'absolute',
    alignSelf: 'center',
    left: '50%',
    marginLeft: -BRACKET / 2,
    width: BRACKET,
    height: BRACKET_THICK,
    borderRadius: 2,
    backgroundColor: '#fff',
  },
  edgeV: {
    position: 'absolute',
    top: '50%',
    marginTop: -BRACKET / 2,
    width: BRACKET_THICK,
    height: BRACKET,
    borderRadius: 2,
    backgroundColor: '#fff',
  },
  failed: {},
  bottom: {
    height: 72,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  chip: {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 14, fontWeight: '600' },
});
