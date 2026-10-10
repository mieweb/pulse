import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { CardShadow, Opacity, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { displayServer } from '@/utils/format';
import { haptics } from '@/utils/haptics';

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
            onPress={() => {
              // A tap that moves the selection; re-tapping the selected chip changes nothing.
              if (selected) return;
              haptics.tap();
              onSelect(d.id);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={`Upload to ${displayServer(d.server)}, ${d.expiryLabel}`}
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
              {/* Always laid out, clear when not selected: a check that only rendered on
                  selection widened the chip and shifted the rail. The chip's own label speaks
                  for it (VoiceOver reads the chip as one element, with its selected state). */}
              <Icon
                name="checkmark.circle.fill"
                size={14}
                tintColor={selected ? theme.accent : 'transparent'}
              />
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

/** The selection ring, as on the captions cue rows and On-device AI's model rows. */
const RING_WIDTH = 1.5;

const styles = StyleSheet.create({
  // Room for the chips' shadows: a horizontal scroll view clips at its edges.
  row: { gap: Spacing.two, paddingVertical: Spacing.two, paddingHorizontal: Spacing.half },
  chip: {
    minWidth: 132,
    maxWidth: 200,
    gap: Spacing.one,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.button,
    borderCurve: 'continuous',
    // A clear hairline at rest keeps the ring math below; selection upgrades it to the accent ring.
    borderWidth: StyleSheet.hairlineWidth,
    ...CardShadow,
  },
  // The accent ring; padding gives back the extra border so the chip's outer size doesn't
  // jitter the rail on selection.
  chipSelected: {
    borderWidth: RING_WIDTH,
    paddingVertical: Spacing.two - (RING_WIDTH - StyleSheet.hairlineWidth),
    paddingHorizontal: Spacing.three - (RING_WIDTH - StyleSheet.hairlineWidth),
  },
  chipHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  // A card-surface control: dims while pressed rather than swapping its fill.
  pressed: { opacity: Opacity.pressed },
});
