import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { CardShadow, Opacity, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { hostOf } from '@/utils/format';
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
            <DestinationLabel server={d.server} size="chip" />
            <ThemedText type="caption2" themeColor="textSecondary">
              {d.expiryLabel}
            </ThemedText>
            {/* The check sits on the ring's top-right corner, off the content, so every chip lays
                out its text the same whether selected or not (inline, it pushed the host in, or
                left a blank gap on the others). The chip's own label speaks for it: VoiceOver
                reads the chip as one element, with its selected state. */}
            {selected && (
              <View style={[styles.check, { backgroundColor: theme.card }]} pointerEvents="none">
                <Icon name="checkmark.circle.fill" size={CHECK_SIZE} tintColor={theme.accent} />
              </View>
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** The selection ring, as on the captions cue rows and On-device AI's model rows. */
const RING_WIDTH = 1.5;
/** The check on the selected chip's corner, and the card-coloured disc it sits on. */
const CHECK_SIZE = 18;
const CHECK_DISC = CHECK_SIZE + 2;
// The rounded corner's curve passes this far in from the box's corner (r · (1 − 1/√2)): the check
// is centred there, on the ring itself rather than off it in the empty corner.
const CORNER_INSET = Radius.button * (1 - Math.SQRT1_2);

const styles = StyleSheet.create({
  // Room for the chips' shadows, and for the check that overhangs a selected chip's top-right
  // corner: a horizontal scroll view clips at its edges.
  row: {
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingLeft: Spacing.half,
    paddingRight: Spacing.two,
  },
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
  // Centred on the corner of the ring; the disc cuts the ring under it so the check reads cleanly.
  check: {
    position: 'absolute',
    top: CORNER_INSET - CHECK_DISC / 2,
    right: CORNER_INSET - CHECK_DISC / 2,
    width: CHECK_DISC,
    height: CHECK_DISC,
    borderRadius: CHECK_DISC / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A card-surface control: dims while pressed rather than swapping its fill.
  pressed: { opacity: Opacity.pressed },
});
