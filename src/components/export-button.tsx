import { Pressable, StyleSheet, Text } from 'react-native';

import { Accent, ButtonHeight, Opacity, Radius } from '@/constants/theme';

const HEIGHT = 32;

/** The draft's way on to the export screen, top right in the recorder and the editor: the screen's
 *  primary action, filled in the accent with the app's button corners scaled to its height. */
export function ExportButton({ onPress, disabled }: { onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Export"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.button,
        disabled ? styles.disabled : pressed && styles.pressed,
      ]}>
      <Text style={styles.text} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        Export
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: HEIGHT,
    paddingHorizontal: 14,
    borderRadius: Math.round((Radius.button * HEIGHT) / ButtonHeight),
    borderCurve: 'continuous',
    backgroundColor: Accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: Opacity.pressed },
  disabled: { opacity: Opacity.disabled },
  text: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
