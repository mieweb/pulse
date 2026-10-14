import { useSharedValue, useAnimatedReaction, type SharedValue } from 'react-native-reanimated';
import {
  useCommonValuesContext,
  useDragContext,
  useIsInPortalOutlet,
  useItemContext,
} from 'react-native-sortables';

// One hold, two views: a hold on the timeline picks a clip up, and the Clips row (sortables)
// drags it, in the same touch. The timeline's gesture keeps the finger; it writes the finger's
// screen position here, and a driver inside the held thumbnail feeds it to sortables through
// the library's own drag handlers, as the thumbnail's gesture would. Sortables then does what
// it always does: lift, swap, scroll near the edges, drop, onDragEnd.

export const Phase = { idle: 0, requested: 1, dragging: 2, released: 3 } as const;

export type Handoff = {
  /** The held clip's id. */
  key: SharedValue<string>;
  /** The finger, in screen coordinates. */
  touch: SharedValue<{ x: number; y: number }>;
  phase: SharedValue<number>;
  /** Sortables' hold-to-drag delay for the handed-off row: none, the hold already happened. */
  delay: SharedValue<number>;
};

export function useHandoff(): Handoff {
  return {
    key: useSharedValue(''),
    touch: useSharedValue({ x: 0, y: 0 }),
    phase: useSharedValue<number>(Phase.idle),
    delay: useSharedValue(0),
  };
}

const noop = () => {
  'worklet';
};

/**
 * Rendered inside a sortables item (its thumbnail): when the handoff names this item, start,
 * move and end its drag with the finger's positions. The touch is placed at the item's centre
 * when it starts; after that only the finger's movement matters to sortables.
 */
export function HandoffDriver(props: { handoff: Handoff; width: number; height: number }) {
  // A lifted item is drawn twice (in place, and in the portal above the screen): drive it once.
  const inPortal = useIsInPortalOutlet();
  return inPortal ? null : <Driver {...props} />;
}

function Driver({ handoff, width, height }: { handoff: Handoff; width: number; height: number }) {
  const { handleTouchStart, handleTouchesMove, handleDragEnd } = useDragContext();
  const item = useItemContext();
  const { itemKey } = item;
  // Typed read-only in the context; it's the item's own progress, which its gesture writes too.
  const activationAnimationProgress = item.activationAnimationProgress as SharedValue<number>;
  const { usesAbsoluteLayout, itemLayoutPositions } = useCommonValuesContext();
  const origin = useSharedValue({ x: 0, y: 0 });

  useAnimatedReaction(
    () => ({
      phase: handoff.phase.get(),
      mine: handoff.key.get() === itemKey,
      touch: handoff.touch.get(),
      ready: usesAbsoluteLayout.value && !!itemLayoutPositions.value[itemKey],
    }),
    ({ phase, mine, touch, ready }) => {
      if (!mine) return;
      const o = origin.get();
      const event = (t: { x: number; y: number }) =>
        ({
          allTouches: [
            {
              id: 0,
              x: width / 2 + t.x - o.x,
              y: height / 2 + t.y - o.y,
              absoluteX: t.x,
              absoluteY: t.y,
            },
          ],
        }) as unknown as Parameters<typeof handleTouchesMove>[0];
      if (phase === Phase.requested && ready) {
        origin.set(touch);
        const start = {
          allTouches: [
            { id: 0, x: width / 2, y: height / 2, absoluteX: touch.x, absoluteY: touch.y },
          ],
        } as unknown as Parameters<typeof handleTouchStart>[0];
        handoff.phase.set(Phase.dragging);
        handleTouchStart(start, itemKey, activationAnimationProgress, noop, () => {
          'worklet';
          handoff.phase.set(Phase.idle);
        });
      } else if (phase === Phase.dragging) {
        handleTouchesMove(event(touch), noop);
      } else if (phase === Phase.released) {
        handleDragEnd(itemKey, activationAnimationProgress);
        handoff.phase.set(Phase.idle);
      }
    },
  );
  return null;
}
