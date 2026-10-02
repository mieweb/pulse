import { StyleSheet } from 'react-native';
import { GestureDetector, type ComposedGesture } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';

import { GlassPill } from '@/components/glass-pill';
import { Icon } from '@/components/icon';

export const MOVE_HANDLE_SIZE = 32;

/**
 * The little grip beside the record button: drag it to put the button anywhere on screen
 * (e.g. where the thumb rests with the phone propped on a desk); double-tap to put it back.
 * Glass, since it floats over the live camera.
 */
export function MoveHandle({ gesture, hidden }: { gesture: ComposedGesture; hidden: boolean }) {
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessible
        accessibilityLabel="Move record button"
        accessibilityHint="Drag to place the record button anywhere. Double-tap to reset."
        hitSlop={8}
        style={{ opacity: hidden ? 0 : 1 }}>
        <GlassPill style={styles.handle}>
          <Icon
            name="arrow.up.and.down.and.arrow.left.and.right"
            size={16}
            weight="semibold"
            tintColor="#fff"
          />
        </GlassPill>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  handle: {
    width: MOVE_HANDLE_SIZE,
    height: MOVE_HANDLE_SIZE,
    borderRadius: MOVE_HANDLE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
