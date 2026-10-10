import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { CardShadow, Opacity, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { clock, cueLoad } from './cue-row';
import { MIN_DUR_CS, type Cue } from './use-subtitle-editor';

// `clock` (m:ss, h:mm:ss from an hour) plus tenths: "1:04.3", "1:02:07.5".
const fine = (cs: number) => `${clock(cs)}.${Math.floor((cs % 100) / 10)}`;

/**
 * Slim strip for the selected cue: its time range (tinted by readability load) and the
 * structural actions — split at playhead, merge with the next cue, delete.
 */
export function CueToolbar({
  cue,
  posCs,
  theme,
  canMerge,
  onSplit,
  onMerge,
  onDelete,
}: {
  cue: Cue;
  posCs: number;
  theme: ReturnType<typeof useTheme>;
  canMerge: boolean;
  onSplit: () => void;
  onMerge: () => void;
  onDelete: () => void;
}) {
  const canSplit = posCs > cue.t0 + MIN_DUR_CS && posCs < cue.t1 - MIN_DUR_CS;
  const load = cueLoad(cue);
  const labelColor =
    load === 'bad' ? theme.accent : load === 'warn' ? theme.warning : theme.textSecondary;

  return (
    <View style={styles.strip}>
      <ThemedText type="footnote" style={[styles.times, { color: labelColor }]}>
        {fine(cue.t0)} – {fine(cue.t1)}
      </ThemedText>
      <View style={styles.tools}>
        <ToolBtn
          name="scissors"
          label="Split at playhead"
          theme={theme}
          disabled={!canSplit}
          onPress={onSplit}
        />
        <ToolBtn
          name="arrow.triangle.merge"
          label="Merge with next"
          theme={theme}
          disabled={!canMerge}
          onPress={onMerge}
        />
        <ToolBtn
          name="trash"
          label="Delete caption"
          theme={theme}
          onPress={onDelete}
          tint={theme.accent}
        />
      </View>
    </View>
  );
}

function ToolBtn({
  name,
  label,
  theme,
  onPress,
  disabled,
  tint,
}: {
  name: IconName;
  label: string;
  theme: ReturnType<typeof useTheme>;
  onPress: () => void;
  disabled?: boolean;
  tint?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      // 30pt + 7 above and below = 44pt tall. Sideways only 3 each: the buttons are 8pt apart,
      // so 7 would overlap the neighbour's slop and a tap just right of Merge would hit Delete.
      hitSlop={TOOL_HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.toolBtn,
        // A card on the grouped background: lifted by a shadow, like the screen's other controls.
        { backgroundColor: theme.card, ...CardShadow },
        disabled && styles.toolDisabled,
        pressed && styles.pressed,
      ]}>
      <Icon name={name} size={14} tintColor={tint ?? theme.text} />
    </Pressable>
  );
}

const TOOL_HIT_SLOP = { top: 7, bottom: 7, left: 3, right: 3 };

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.one,
  },
  times: { fontVariant: ['tabular-nums'] },
  tools: { flexDirection: 'row', gap: Spacing.two },
  toolBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolDisabled: { opacity: Opacity.disabled },
  pressed: { opacity: Opacity.pressed },
});
