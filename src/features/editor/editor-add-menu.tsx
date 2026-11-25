import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';

import type { MenuAction } from '@/components/action-menu';
import { Icon } from '@/components/icon';
import { ProgressRing } from '@/components/progress-ring';
import { Opacity } from '@/constants/theme';
import { BatchCount } from '@/features/recorder/batch-count';
import { PlusMenu } from '@/features/recorder/plus-menu';
import { useTheme } from '@/hooks/use-theme';

/** The "+" circle's diameter: the recorder's, and a full touch target. */
export const ADD_SIZE = 44;

/**
 * The editor's sticky right-edge "+" inserts at the exact playhead, appending at the end.
 * Drawn like the recorder's "+" (a round 44 pt button with a plus), in the theme's inverted colours so it reads
 * over the clips and the background alike. While a video it started is converting it shows a
 * spinner, or a ring once the conversion reports progress, and takes no taps.
 */
export function EditorAddMenu({
  actions,
  busy,
  progress,
  progressText,
  progressCount,
  onOpen,
}: {
  actions: MenuAction[];
  /** The "+" was pressed, before the menu opens. */
  onOpen?: () => void;
  busy: boolean;
  progress: number | null;
  /** What it's busy with, read with the progress ("Adding 2 of 5"). */
  progressText?: string;
  /** Shown beside the ring during a batch of images ("2/5"). */
  progressCount?: string;
}) {
  const theme = useTheme();
  const ring = busy ? progress : null;
  const label = 'Insert at playhead';
  const hint =
    'Adds clips at the playhead, splitting the current clip if needed. At the end, appends a new beat.';
  return (
    <PlusMenu
      actions={actions}
      enabled={!busy}
      onOpen={onOpen}
      label={label}
      hint={hint}
      size={ADD_SIZE}
      renderButton={(onPress) => (
        <Pressable
          onPress={onPress}
          disabled={busy}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={hint}
          accessibilityState={{ busy, disabled: busy }}
          accessibilityValue={
            ring != null
              ? { min: 0, max: 100, now: Math.round(ring * 100), text: progressText }
              : undefined
          }
          testID="editor.addClips"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: theme.text, borderColor: theme.background },
            pressed && styles.pressed,
          ]}>
          {ring != null ? (
            <ProgressRing progress={ring} color={theme.background} trackColor={theme.border} />
          ) : busy ? (
            <ActivityIndicator size="small" color={theme.background} />
          ) : (
            <Icon name="plus" size={24} weight="medium" tintColor={theme.background} />
          )}
          {busy && progressCount ? (
            <BatchCount text={progressCount} color={theme.text} background={theme.background} />
          ) : null}
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  button: {
    width: ADD_SIZE,
    height: ADD_SIZE,
    borderRadius: ADD_SIZE / 2,
    // A ring of the background, so the circle stands off the clip under it.
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: Opacity.pressed },
});
