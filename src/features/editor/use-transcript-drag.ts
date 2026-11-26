import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LayoutChangeEvent, LayoutRectangle } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import Animated, {
  scrollTo,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import {
  transcriptDragSelection,
  transcriptWordAtPoint,
  type TranscriptWordBox,
} from './transcript-drag';

/** Native selection owns drags that start on words; blank space remains a scroll surface. */
export function useTranscriptDrag({
  words,
  selected,
  enabled,
  onChange,
  onStart,
}: {
  words: readonly { id: string; group: string }[];
  selected: ReadonlySet<string>;
  enabled: boolean;
  onChange: (selection: ReadonlySet<string>, endIndex: number) => void;
  onStart: () => void | (() => void);
}) {
  const [dragging, setDragging] = useState(false);
  const current = useRef({ words, selected, enabled, onChange, onStart });
  useLayoutEffect(() => {
    current.current = { words, selected, enabled, onChange, onStart };
  });
  const session = useRef<{
    token: number;
    version: number;
    anchor: number;
    ids: string[];
    baseline: ReadonlySet<string>;
    restore?: () => void;
  } | null>(null);
  const alive = useRef(true);
  const version = useRef(0);
  const suppressPressUntil = useRef(0);
  const groups = useRef(new Map<string, LayoutRectangle>());
  const paragraphs = useRef(new Map<string, LayoutRectangle>());
  const wordLayouts = useRef(new Map<string, LayoutRectangle>());
  const publishFrame = useRef<number | null>(null);
  const boxes = useSharedValue<TranscriptWordBox[]>([]);
  const scrollY = useSharedValue(0);
  const viewportHeight = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  const active = useSharedValue(false);
  const allowed = useSharedValue(enabled);
  const generation = useSharedValue(0);
  const token = useSharedValue(0);
  const anchor = useSharedValue(-1);
  const end = useSharedValue(-1);
  const downX = useSharedValue(0);
  const downY = useSharedValue(0);
  const pointerX = useSharedValue(0);
  const pointerY = useSharedValue(0);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();

  const cancel = useCallback(() => {
    const previous = session.current;
    session.current = null;
    version.current++;
    generation.set(version.current);
    active.set(false);
    anchor.set(-1);
    if (alive.current) {
      if (previous) current.current.onChange(previous.baseline, previous.anchor);
      previous?.restore?.();
      setDragging(false);
    }
  }, [active, anchor, generation]);

  const idsKey = JSON.stringify(words.map((word) => word.id));
  useLayoutEffect(() => {
    cancel();
    allowed.set(enabled);
  }, [enabled, idsKey, cancel, allowed]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      session.current = null;
      active.set(false);
      if (publishFrame.current !== null) cancelAnimationFrame(publishFrame.current);
    };
  }, [active]);

  const move = useCallback(
    (gestureToken: number, layoutVersion: number, from: number, to: number) => {
      if (!alive.current || !current.current.enabled || version.current !== layoutVersion) return;
      let drag = session.current;
      if (!drag || drag.token !== gestureToken) {
        drag = {
          token: gestureToken,
          version: layoutVersion,
          anchor: from,
          ids: current.current.words.map((word) => word.id),
          baseline: new Set(current.current.selected),
        };
        session.current = drag;
        drag.restore = current.current.onStart() ?? undefined;
        setDragging(true);
      }
      suppressPressUntil.current = Date.now() + 250;
      current.current.onChange(
        transcriptDragSelection(drag.ids, drag.baseline, drag.anchor, to),
        to,
      );
    },
    [],
  );
  const finish = useCallback((gestureToken: number, success: boolean) => {
    const drag = session.current;
    if (!alive.current || !drag || drag.token !== gestureToken) return;
    session.current = null;
    suppressPressUntil.current = Date.now() + 250;
    if (!success) {
      current.current.onChange(drag.baseline, drag.anchor);
      drag.restore?.();
    }
    setDragging(false);
  }, []);
  const touchDown = useCallback(() => {
    // A fresh tap is independent of the trailing Pressable event from a preceding drag.
    suppressPressUntil.current = 0;
  }, []);
  const consumePress = useCallback(
    () => session.current !== null || Date.now() < suppressPressUntil.current,
    [],
  );
  const isActive = useCallback(() => active.get() || session.current !== null, [active]);

  const updateEnd = useCallback(() => {
    'worklet';
    const hit = transcriptWordAtPoint(
      boxes.get(),
      {
        x: pointerX.get(),
        y: scrollY.get() + Math.max(0, Math.min(viewportHeight.get(), pointerY.get())),
      },
      { nearest: true },
    );
    if (!hit || hit.index === end.get()) return;
    end.set(hit.index);
    scheduleOnRN(move, token.get(), generation.get(), anchor.get(), hit.index);
  }, [boxes, scrollY, viewportHeight, pointerX, pointerY, end, move, token, generation, anchor]);
  const [native] = useState(() => Gesture.Native());
  // eslint-disable-next-line react-hooks/refs -- RNGH stores these callbacks; refs are read only when native touch events dispatch them.
  const [pan] = useState(() =>
    Gesture.Pan()
      .manualActivation(true)
      .maxPointers(1)
      .shouldCancelWhenOutside(false)
      .blocksExternalGesture(native)
      .onTouchesDown((event, manager) => {
        const point = event.allTouches[0];
        if (!allowed.get() || event.numberOfTouches !== 1 || !point) {
          manager.fail();
          return;
        }
        scheduleOnRN(touchDown);
        const hit = transcriptWordAtPoint(boxes.get(), {
          x: point.x,
          y: point.y + scrollY.get(),
        });
        if (!hit) {
          manager.fail();
          return;
        }
        token.set(token.get() + 1);
        anchor.set(hit.index);
        end.set(-1);
        downX.set(point.x);
        downY.set(point.y);
        pointerX.set(point.x);
        pointerY.set(point.y);
      })
      .onTouchesMove((event, manager) => {
        const point = event.allTouches[0];
        if (!allowed.get() || event.numberOfTouches !== 1 || !point || anchor.get() < 0) {
          manager.fail();
          return;
        }
        pointerX.set(point.x);
        pointerY.set(point.y);
        if (!active.get() && Math.hypot(point.x - downX.get(), point.y - downY.get()) >= 6)
          manager.activate();
      })
      .onStart(() => {
        if (!allowed.get() || anchor.get() < 0) return;
        active.set(true);
        updateEnd();
      })
      .onUpdate((event) => {
        if (!active.get() || anchor.get() < 0) return;
        pointerX.set(event.x);
        pointerY.set(event.y);
        updateEnd();
      })
      .onEnd((event, success) => {
        if (!success || !active.get()) return;
        pointerX.set(event.x);
        pointerY.set(event.y);
        updateEnd();
      })
      .onTouchesUp((_event, manager) => {
        if (!active.get()) manager.fail();
      })
      .onFinalize((_event, success) => {
        active.set(false);
        anchor.set(-1);
        end.set(-1);
        scheduleOnRN(finish, token.get(), success);
      }),
  );
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.set(event.contentOffset.y);
    if (active.get()) updateEnd();
  });
  useFrameCallback((frame) => {
    if (!active.get()) return;
    const height = viewportHeight.get();
    const edge = Math.min(56, height / 4);
    const y = pointerY.get();
    const amount =
      y < edge
        ? -Math.min(1, (edge - y) / edge)
        : y > height - edge
          ? Math.min(1, (y - height + edge) / edge)
          : 0;
    if (!amount || height <= 0) return;
    const next = Math.max(
      0,
      Math.min(
        contentHeight.get() - height,
        scrollY.get() + (amount * 500 * Math.min(frame.timeSincePreviousFrame ?? 16, 32)) / 1000,
      ),
    );
    if (next === scrollY.get()) return;
    scrollY.set(next);
    scrollTo(scrollRef, 0, next, false);
    updateEnd();
  });

  const publish = useCallback(() => {
    if (publishFrame.current !== null) return;
    publishFrame.current = requestAnimationFrame(() => {
      publishFrame.current = null;
      // Reflow (rotation or text-size changes) invalidates an in-progress caret position.
      cancel();
      const measured = current.current.words.flatMap((word, index) => {
        const group = groups.current.get(word.group);
        const paragraph = paragraphs.current.get(word.group);
        const box = wordLayouts.current.get(word.id);
        return group && paragraph && box
          ? [
              {
                id: word.id,
                index,
                x: group.x + paragraph.x + box.x,
                y: group.y + paragraph.y + box.y,
                width: box.width,
                height: box.height,
              },
            ]
          : [];
      });
      boxes.set(measured);
    });
  }, [boxes, cancel]);
  useLayoutEffect(() => {
    boxes.set([]);
    publish();
  }, [idsKey, boxes, publish]);
  const groupLayout = (id: string, event: LayoutChangeEvent) => {
    groups.current.set(id, event.nativeEvent.layout);
    publish();
  };
  const paragraphLayout = (id: string, event: LayoutChangeEvent) => {
    paragraphs.current.set(id, event.nativeEvent.layout);
    publish();
  };
  const wordLayout = (id: string, event: LayoutChangeEvent) => {
    wordLayouts.current.set(id, event.nativeEvent.layout);
    publish();
  };
  const viewportLayout = (event: LayoutChangeEvent) =>
    viewportHeight.set(event.nativeEvent.layout.height);
  const contentSize = (_width: number, height: number) => contentHeight.set(height);
  return {
    dragging,
    cancel,
    consumePress,
    isActive,
    pan,
    native,
    scrollRef,
    onScroll,
    viewportLayout,
    contentSize,
    groupLayout,
    paragraphLayout,
    wordLayout,
  };
}
