import { Icon } from '@/components/icon';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated from 'react-native-reanimated';

import { ButtonHeight, Opacity, Radius } from '@/constants/theme';
import { CONTROLS_FADE } from './record-button';

const HEIGHT = 32;

/** The editor control left of the record button, opposite the "+" import: opens the draft in the
 *  editor from its start. Labelled, so the editor is easy to find; the same size and corners as
 *  the Export button. */
export function EditButton({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  // Dims with the record controls while a clip records, as the "+" does.
  return (
    <Animated.View style={[CONTROLS_FADE, { opacity: disabled ? Opacity.disabled : 1 }]}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Edit clips"
        accessibilityState={{ disabled }}
        style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
        <Icon name="scissors" size={15} weight="semibold" tintColor="#000" />
        <Text style={styles.text} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          Edit
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  button: {
    height: HEIGHT,
    paddingHorizontal: 14,
    gap: 6,
    flexDirection: 'row',
    borderRadius: Math.round((Radius.button * HEIGHT) / ButtonHeight),
    borderCurve: 'continuous',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { color: '#000', fontSize: 15, fontWeight: '600' },
  pressed: { opacity: Opacity.pressed },
});
