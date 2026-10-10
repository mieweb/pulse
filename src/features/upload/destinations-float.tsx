import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { EaseOut } from '@/constants/motion';
import { FloatShadow, Opacity, Spacing } from '@/constants/theme';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
import { formatCount, hostOf } from '@/utils/format';

import { useDestinations } from './use-destinations';

/** The home screen's + FAB (`styles.fab` in app/index.tsx): 60pt square, `Spacing.four` from the right. */
const FAB_SIZE = 60;
const FAB_CLEARANCE = Spacing.four + FAB_SIZE + Spacing.three;
/** Longest the pill gets on wide screens, so it stays a pill rather than a bar. */
const PILL_MAX_WIDTH = 280;

/**
 * The pill fades in when the first server is paired and out when the last one goes. Opacity only,
 * so it runs under Reduce Motion too: Reanimated's default would skip it there and pop the pill in.
 */
const ENTERING = FadeIn.duration(200).easing(EaseOut).reduceMotion(ReduceMotion.Never);
const EXITING = FadeOut.duration(150).easing(EaseOut).reduceMotion(ReduceMotion.Never);

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
  const dark = useThemeMode() === 'dark';
  const { destinations } = useDestinations();
  // One sheet per tap: a second tap before the first sheet is up would push another on top of it.
  // Open again once Home is back in focus (the sheet closed).
  const opening = useRef(false);
  useFocusEffect(
    useCallback(() => {
      opening.current = false;
    }, []),
  );

  if (destinations.length === 0) return null;

  return (
    // The lane runs from the left margin to just short of the + FAB, so a long host truncates
    // instead of sliding under it; taps outside the pill fall through to the list. The lane is
    // what mounts and unmounts, so it carries the fade.
    <Animated.View
      entering={ENTERING}
      exiting={EXITING}
      pointerEvents="box-none"
      style={[styles.lane, { bottom: insets.bottom + Spacing.four }]}>
      <Pressable
        // The count picks the sheet's size up front (`destinationsSheetOptions`).
        onPress={() => {
          if (opening.current) return;
          opening.current = true;
          router.push({
            pathname: '/destinations',
            params: { count: String(destinations.length) },
          });
        }}
        accessibilityRole="button"
        accessibilityLabel={formatCount(
          destinations.length,
          'upload destination',
          'upload destinations',
        )}
        style={({ pressed }) => [
          styles.pill,
          {
            // Floating, so one step up in dark mode, where the shadow doesn't show: on `card` it
            // blended into the draft cards it floats over.
            backgroundColor: dark ? theme.cardRaised : theme.card,
            opacity: pressed ? Opacity.pressed : 1,
          },
        ]}>
        <Icon name="icloud.and.arrow.up" size={18} tintColor={theme.text} scalesWithText={1.6} />
        {/* Middle truncation keeps the domain's end (e.g. "…mieweb.org") visible. Capped so the
            largest text sizes grow the pill without it towering over the FAB beside it. */}
        <ThemedText
          type="subheadlineEmphasized"
          numberOfLines={1}
          ellipsizeMode="middle"
          maxFontSizeMultiplier={1.6}
          style={styles.pillLabel}>
          {destinations.length === 1
            ? hostOf(destinations[0].server)
            : formatCount(destinations.length, 'destination', 'destinations')}
        </ThemedText>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  lane: {
    position: 'absolute',
    left: Spacing.four,
    right: FAB_CLEARANCE,
    // At least the FAB's height, same bottom, so the pill centres on the FAB's centre line; a pill
    // grown by large text grows the lane upward instead of spilling out of it.
    minHeight: FAB_SIZE,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  pill: {
    maxWidth: PILL_MAX_WIDTH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    // 44 pt; the label's cap (1.6 × a 20 pt line, plus this padding) keeps it there at the largest
    // text sizes, and a minimum rather than a fixed height means it grows instead of clipping if
    // that ever changes.
    minHeight: 44,
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.three,
    borderRadius: 22,
    ...FloatShadow,
  },
  // Shrinks below its text width so `numberOfLines` can truncate inside the pill.
  pillLabel: { flexShrink: 1 },
});
