import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { CardShadow, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { hostOf } from '@/utils/format';

import { DestinationLabel } from './destination-label';
import type { DestinationOption } from './use-destinations';

/**
 * Horizontal, scrollable picker of paired upload destinations (§ destination pool). Shown on the
 * export screen so the user can change their mind about *where* to send a pulse right up to the
 * moment they tap Upload. Each chip names the destination (`DestinationLabel`, as in the
 * destinations sheet) and its expiry; the
 * selected one is outlined in the accent color. Selection is presentational only — nothing is
 * committed until the Upload button claims the selected destination.
 */
export function DestinationSelector({
  destinations,
  selectedId,
  onSelect,
}: {
  destinations: DestinationOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const theme = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      accessibilityRole="radiogroup">
      {destinations.map((d) => {
        const selected = d.id === selectedId;
        return (
          <Pressable
            key={d.id}
            onPress={() => onSelect(d.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={`Upload to ${hostOf(d.server)}, ${d.expiryLabel}`}
            style={({ pressed }) => [
              styles.chip,
              {
                backgroundColor: theme.card,
                // The ring marks the selected chip; the rest lift on a shadow, no outline.
                borderColor: selected ? theme.accent : 'transparent',
              },
              selected && styles.chipSelected,
              pressed && styles.pressed,
            ]}>
            <View style={styles.chipHeader}>
              {selected && <Icon name="checkmark.circle.fill" size={14} tintColor={theme.accent} />}
              <DestinationLabel server={d.server} size="chip" />
            </View>
            <ThemedText type="caption2" themeColor="textSecondary">
              {d.expiryLabel}
            </ThemedText>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Room for the chips' shadows: a horizontal scroll view clips at its edges.
  row: { gap: Spacing.two, paddingVertical: Spacing.two, paddingHorizontal: Spacing.half },
  chip: {
    minWidth: 132,
    maxWidth: 200,
    gap: Spacing.one,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: 14,
    // A clear hairline at rest keeps the ring math below; selection upgrades it to 2pt accent.
    borderWidth: StyleSheet.hairlineWidth,
    ...CardShadow,
  },
  // 2pt accent ring; padding gives back the extra border so the chip's outer size doesn't
  // jitter the rail on selection.
  chipSelected: {
    borderWidth: 2,
    paddingVertical: Spacing.two - (2 - StyleSheet.hairlineWidth),
    paddingHorizontal: Spacing.three - (2 - StyleSheet.hairlineWidth),
  },
  chipHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  pressed: { opacity: 0.85 },
});
