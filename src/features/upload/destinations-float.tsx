import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { hostOf } from '@/utils/format';

import { useDestinations } from './use-destinations';

/** The home screen's + FAB (`styles.fab` in app/index.tsx): 60pt square, `Spacing.four` from the right. */
const FAB_SIZE = 60;
const FAB_CLEARANCE = Spacing.four + FAB_SIZE + Spacing.three;
/** Longest the pill gets on wide screens, so it stays a pill rather than a bar. */
const PILL_MAX_WIDTH = 280;

/**
 * A floating pill on the home screen surfacing the device-wide pool of paired upload destinations
 * (§ destination pool). Tapping it opens the destinations sheet (destinations-sheet.tsx) to
 * *view and delete* every non-expired destination — its host and expiry. View/delete only;
 * picking *which* one to upload to happens later, on the export screen. Renders nothing when the
 * pool is empty, so it only appears once at least one server is paired, and disappears as
 * destinations are consumed by finished uploads, deleted there, or expire.
 */
export function DestinationsFloat() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { destinations } = useDestinations();

  if (destinations.length === 0) return null;

  return (
    // The lane runs from the left margin to just short of the + FAB, so a long host truncates
    // instead of sliding under it; taps outside the pill fall through to the list.
    <View pointerEvents="box-none" style={[styles.lane, { bottom: insets.bottom + Spacing.four }]}>
      <Pressable
        // The count picks the sheet's size up front (`destinationsSheetOptions`).
        onPress={() =>
          router.push({
            pathname: '/destinations',
            params: { count: String(destinations.length) },
          })
        }
        accessibilityRole="button"
        accessibilityLabel={`${destinations.length} upload ${
          destinations.length === 1 ? 'destination' : 'destinations'
        }`}
        style={({ pressed }) => [
          styles.pill,
          {
            backgroundColor: theme.card,
            opacity: pressed ? 0.85 : 1,
          },
        ]}>
        <Icon name="icloud.and.arrow.up" size={18} tintColor={theme.text} />
        {/* Middle truncation keeps the domain's end (e.g. "…mieweb.org") visible. */}
        <ThemedText
          type="smallBold"
          numberOfLines={1}
          ellipsizeMode="middle"
          style={styles.pillLabel}>
          {destinations.length === 1
            ? hostOf(destinations[0].server)
            : `${destinations.length} destinations`}
        </ThemedText>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  lane: {
    position: 'absolute',
    left: Spacing.four,
    right: FAB_CLEARANCE,
    // Same height and bottom as the FAB, so the pill centres on the FAB's centre line.
    height: FAB_SIZE,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  pill: {
    maxWidth: PILL_MAX_WIDTH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    height: 44,
    paddingHorizontal: Spacing.three,
    borderRadius: 22,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  // Shrinks below its text width so `numberOfLines` can truncate inside the pill.
  pillLabel: { flexShrink: 1 },
});
