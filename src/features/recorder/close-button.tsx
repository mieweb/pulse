import { Icon } from '@/components/icon';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { GlassPill } from '@/components/glass-pill';
import { ControlScrim } from '@/constants/theme';
import { useThemeMode } from '@/hooks/use-theme';
import { closeToHome } from '@/utils/navigation';

export function CloseButton({
  onPress,
  style,
  overVideo = false,
  label = 'Close',
}: {
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  /**
   * True when the button floats over live/video content (the recorder) — renders the Liquid
   * Glass pill there. On themed screens (export, caption editor, permission gate, the
   * preview backdrop) glass is wrong: it has nothing to refract over a flat background and
   * dark-pinned glass turns nearly transparent in light mode — those get the mode-aware
   * scrim instead (dark fill on light, light fill + hairline edge on dark).
   */
  overVideo?: boolean;
  /** Screen-reader label — override when the ✕ means something more specific than "Close". */
  label?: string;
}) {
  const mode = useThemeMode();
  const inner = <Icon name="xmark" size={22} weight="semibold" tintColor="#fff" />;
  return (
    <Pressable
      onPress={onPress ?? closeToHome}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={style}>
      {overVideo ? (
        <GlassPill style={styles.button}>{inner}</GlassPill>
      ) : (
        <View style={[styles.button, styles.scrim, ControlScrim[mode]]}>{inner}</View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  scrim: { borderWidth: StyleSheet.hairlineWidth },
});
