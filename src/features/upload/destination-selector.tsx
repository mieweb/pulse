import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { hostOf } from '@/utils/format';

import type { DestinationOption } from './use-destinations';

/**
 * Horizontal, scrollable picker of paired upload destinations (§ destination pool). Shown on the
 * export screen so the user can change their mind about *where* to send a pulse right up to the
 * moment they tap Upload. Each chip names the host and its expiry; the
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
                backgroundColor: theme.backgroundElement,
                borderColor: selected ? theme.accent : theme.border,
              },
              selected && styles.chipSelected,
              pressed && styles.pressed,
            ]}>
            <View style={styles.chipHeader}>
              {selected && <Icon name="checkmark.circle.fill" size={14} tintColor={theme.accent} />}
              <ThemedText type="smallBold" numberOfLines={1} style={styles.host}>
                {hostOf(d.server)}
              </ThemedText>
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
  row: { gap: Spacing.two, paddingVertical: Spacing.one },
  chip: {
    minWidth: 132,
    maxWidth: 200,
    gap: Spacing.one,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: 14,
    // Hairline at rest; selection upgrades to the 2pt accent ring below.
    borderWidth: StyleSheet.hairlineWidth,
  },
  // 2pt accent ring; padding gives back the extra border so the chip's outer size doesn't
  // jitter the rail on selection.
  chipSelected: {
    borderWidth: 2,
    paddingVertical: Spacing.two - (2 - StyleSheet.hairlineWidth),
    paddingHorizontal: Spacing.three - (2 - StyleSheet.hairlineWidth),
  },
  chipHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  host: { flexShrink: 1 },
  pressed: { opacity: 0.85 },
});
