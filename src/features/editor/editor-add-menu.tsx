import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native';
import { useAnimatedReaction, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import type { MenuAction } from '@/components/action-menu';
import { Icon } from '@/components/icon';
import { ProgressRing } from '@/components/progress-ring';
import { Opacity } from '@/constants/theme';
import { playheadSlot } from '@/core/clip-anchor';
import { PlusMenu } from '@/features/recorder/plus-menu';
import { useTheme } from '@/hooks/use-theme';

/** The "+" circle's diameter: the recorder's, and a full touch target. */
export const ADD_SIZE = 44;

/**
 * The slot the "+" adds at (0 before the first clip … `starts.length` at the end), following the
 * playhead on the UI thread; React hears only when it changes, for the button's hint.
 */
export function usePlayheadSlot(
  starts: readonly number[],
  totalMs: number,
  timeMs: SharedValue<number>,
): number {
  const [slot, setSlot] = useState(starts.length);
  useAnimatedReaction(
    () => playheadSlot(starts, totalMs, timeMs.get()).slot,
    (s, prev) => {
      if (s !== prev) scheduleOnRN(setSlot, s);
    },
    [starts, totalMs],
  );
  return Math.min(slot, starts.length);
}

/** Where the "+" adds, for VoiceOver and TalkBack: positions, counted from 1. */
export function addPositionHint(slot: number, clipCount: number): string {
  if (clipCount === 0 || slot >= clipCount) return 'Adds clips at the end.';
  if (slot <= 0) return 'Adds clips at the start, before clip 1.';
  return `Adds clips between clips ${slot} and ${slot + 1}.`;
}

/**
 * The editor's "+", at the right edge of the clips in both views: the shared add menu
 * (`PlusMenu`) with the editor's items, which add at the playhead's clip boundary. Drawn like the
 * recorder's "+" (a round 44 pt button with a plus), in the theme's inverted colours so it reads
 * over the clips and the background alike. While a video it started is converting it shows a
 * spinner, or a ring once the conversion reports progress, and takes no taps.
 */
export function EditorAddMenu({
  actions,
  busy,
  progress,
  progressText,
  hint,
  onOpen,
}: {
  actions: MenuAction[];
  /** The "+" was pressed, before the menu opens. */
  onOpen?: () => void;
  busy: boolean;
  progress: number | null;
  /** What it's busy with, read with the progress ("Adding 2 of 5"). */
  progressText?: string;
  hint: string;
}) {
  const theme = useTheme();
  const ring = busy ? progress : null;
  const label = 'Add clips here';
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
