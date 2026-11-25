import { Pressable, StyleSheet, Text } from 'react-native';

import { Icon } from '@/components/icon';
import { Accent, ButtonHeight, Opacity, Radius } from '@/constants/theme';

const HEIGHT = 44;

/** The draft's way on to the export screen, in the recorder and editor's bottom command row: the screen's
 *  primary action, filled in the accent with the app's button corners scaled to its height. */
export function ExportButton({
  onPress,
  disabled,
  testID,
  compact = false,
}: {
  onPress: () => void;
  disabled?: boolean;
  /** For UI automation. */
  testID?: string;
  /** An icon-only, full-size target when the action shares an editing toolbar. */
  compact?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel="Export"
      accessibilityState={{ disabled }}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compact,
        disabled ? styles.disabled : pressed && styles.pressed,
      ]}>
      {compact ? (
        <Icon name="square.and.arrow.up" size={20} weight="semibold" tintColor="#fff" />
      ) : (
        <Text style={styles.text} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          Export
        </Text>
      )}
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
  compact: { width: HEIGHT, paddingHorizontal: 0 },
  disabled: { opacity: Opacity.disabled },
  text: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
