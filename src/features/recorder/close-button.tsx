import { Icon } from '@/components/icon';
import { createContext, useContext } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { GlassPill } from '@/components/glass-pill';
import { ControlScrim, Opacity } from '@/constants/theme';
import { useThemeMode } from '@/hooks/use-theme';

/**
 * What a ✕ does when its parent can't pass `onClose` down: the permission gate's, whose screen
 * provides it. Without either, the button does nothing (a shell always gives the screen a way out).
 */
export const CloseAction = createContext<(() => void) | null>(null);

export function CloseButton({
  onClose,
  style,
  overVideo = false,
  label = 'Close',
  testID,
}: {
  /** Leaves the screen; the shell decides where to (this button never navigates). */
  onClose?: () => void;
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
  /** For UI automation. */
  testID?: string;
}) {
  const mode = useThemeMode();
  const inherited = useContext(CloseAction);
  const close = onClose ?? inherited ?? undefined;
  const icon = <Icon name="xmark" size={22} weight="semibold" tintColor="#fff" />;
  return (
    <Pressable
      onPress={close}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      // The glass pill dims only its glyph: a partly transparent ancestor makes iOS draw the
      // glass flat (and it can stay that way). The scrim has no glass, so the whole button dims.
      style={({ pressed }) => [style, pressed && !overVideo && styles.pressed]}>
      {({ pressed }) =>
        overVideo ? (
          <GlassPill style={styles.button}>
            {/* Not collapsable: without a style this view is flattened away, so a press would move
                the glyph into a new native parent. The ✕ pops the screen in the same frame, and on
                Android the popped screen's views are already held for its exit animation by then:
                the move crashed (`addViewAt ... already has a parent`). Kept as a view, a press is
                only an opacity change. */}
            <View collapsable={false} style={pressed && styles.pressed}>
              {icon}
            </View>
          </GlassPill>
        ) : (
          <View style={[styles.button, styles.scrim, ControlScrim[mode]]}>{icon}</View>
        )
      }
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  scrim: { borderWidth: StyleSheet.hairlineWidth },
  pressed: { opacity: Opacity.pressed },
});
