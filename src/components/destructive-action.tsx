import { Pressable, StyleSheet } from 'react-native';

import { Opacity, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { Icon } from './icon';
import { ThemedText } from './themed-text';

/**
 * The app's one destructive text action, centred below the list it acts on ("Remove all",
 * "Remove model & free up space"): accent text with a trash glyph. The touch area is only as wide
 * as the label, so a tap beside it can't remove anything.
 */
export function DestructiveAction({
  label,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={Spacing.two}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
      <Icon name="trash" size={16} tintColor={theme.accent} />
      <ThemedText type="subheadlineEmphasized" themeColor="accent">
        {label}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
  },
  pressed: { opacity: Opacity.pressedGlyph },
});
