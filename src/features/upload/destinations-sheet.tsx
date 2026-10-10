import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DestructiveAction } from '@/components/destructive-action';
import { Icon } from '@/components/icon';
import { compatLabel, type ServerCompat } from '@/features/about/details';
import { useServerCompatibility } from '@/features/about/use-server-compatibility';
import { ThemedText } from '@/components/themed-text';
import { EaseOut, ListReflowMs } from '@/constants/motion';
import { CardShadow, Opacity, Radius, Spacing, type ThemeColor } from '@/constants/theme';
import { useToast } from '@/features/toast/toast-provider';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
import { formatCount, hostOf } from '@/utils/format';
import { tallSheetFits } from '@/utils/sheet-fit';
import { userMessage } from '@/utils/user-message';

import { DestinationLabel } from './destination-label';
import { type DestinationOption, useDestinations } from './use-destinations';

/**
 * Up to this many, the sheet sizes to its rows. Beyond, it opens at about 60% height and
 * scrolling the list (or dragging the grabber) expands it to full height first, like the system's
 * own sheets. Decided when the sheet opens, from the count the home pill passes, so the size
 * doesn't jump once the list has loaded.
 */
const MAX_FITTED = 5;

/**
 * A removed row fades out while the rows after it close the gap. The fade is opacity only, so it runs under Reduce Motion too (Reanimated's default would skip it
 * and drop the row at once).
 */
const ROW_LAYOUT = LinearTransition.duration(ListReflowMs).easing(EaseOut);
const ROW_EXITING = FadeOut.duration(150).easing(EaseOut).reduceMotion(ReduceMotion.Never);

/**
 * Whether the sheet opens in its scrolling 60% → full-height mode: past `MAX_FITTED` rows, or at
 * any count when large text or a short screen would clip a fitted sheet (`tallSheetFits`). An
 * unknown count (`/destinations` opened by a link, without `?count`, reads as NaN) counts as many:
 * a sheet that scrolls fits a short list too, while a fitted one clips a long list.
 */
function scrollsFor(count: number): boolean {
  return !Number.isFinite(count) || count > MAX_FITTED || !tallSheetFits();
}

/** The route's presentation for a pool of `count` destinations (see `scrollsFor`). */
export function destinationsSheetOptions(count: number) {
  return scrollsFor(count)
    ? {
        sheetAllowedDetents: [0.6, 1],
        sheetInitialDetentIndex: 0,
        sheetExpandsWhenScrolledToEdge: true,
      }
    : { sheetAllowedDetents: 'fitToContents' as const };
}

/** Soonest-expiring first, so the ones about to drop out are on top; no expiry last. */
function byExpiry(a: DestinationOption, b: DestinationOption): number {
  return (a.expiresAtMs ?? Infinity) - (b.expiresAtMs ?? Infinity);
}

/**
 * The device-wide pool of paired upload destinations (§ destination pool), opened from the home
 * screen's destinations pill: each destination's name (`DestinationLabel`), expiry and its server's
 * compatibility with this app, soonest-expiring first, to *view and delete*. Picking which one to upload to happens on the export screen. Same sheet style as
 * the pairing sheet.
 */
export function DestinationsSheet() {
  const theme = useTheme();
  const mode = useThemeMode();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const { destinations: pool, deleteDestination } = useDestinations();
  const destinations = useMemo(() => [...pool].sort(byExpiry), [pool]);
  // Same decision as the route's options (`destinationsSheetOptions`), from the same count.
  const { count } = useLocalSearchParams<{ count?: string }>();
  const [scrolls] = useState(() => scrollsFor(Number(count)));
  // Each server's compatibility with this app, checked live when the sheet opens.
  const compat = useServerCompatibility();
  const compatOf = (server: string) => compat.find((c) => c.server === server);

  // The last one removed (or expired) leaves nothing to show: close. Only after there was one —
  // the list loads asynchronously, so it's empty for the first frame too.
  const empty = destinations.length === 0;
  const hadDestinations = useRef(false);
  useEffect(() => {
    if (!empty) hadDestinations.current = true;
    else if (hadDestinations.current && router.canGoBack()) router.back();
  }, [empty]);

  // Removed at once, no confirmation, and a toast says what went. Removing the last one closes
  // the sheet (above); the toast stays up over home.
  const remove = (removed: DestinationOption[]) => {
    void Promise.allSettled(removed.map((d) => deleteDestination(d.id))).then((results) => {
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) {
        // Any that did go are gone from the list; the rest stay, so trying again is one tap.
        showToast({
          kind: 'error',
          title:
            removed.length === 1
              ? 'Couldn’t remove the destination'
              : 'Couldn’t remove the destinations',
          message: userMessage(failed.reason, 'Try again.', 'destinations'),
        });
        return;
      }
      showToast({
        kind: 'info',
        // One names the server it was (its host, as its row did); several are counted.
        ...(removed.length === 1
          ? { title: 'Destination removed', message: hostOf(removed[0].server) }
          : { title: `${formatCount(removed.length, 'destination', 'destinations')} removed` }),
      });
    });
  };

  // Animated only when the sheet scrolls. A fitted sheet (`fitToContents`) is sized by iOS to its
  // content: a removed row shrinks the content at once and iOS animates the sheet down to it, so a
  // reflow on top would slide the rows (and the fading row) below the sheet's new bottom edge, out
  // of step with the sheet's own resize. The scrolling sheet's height is its detent, not its
  // content, so there the rows can close the gap themselves.
  const layout = scrolls ? ROW_LAYOUT : undefined;
  const exiting = scrolls ? ROW_EXITING : undefined;

  const rows = destinations.map((d) => (
    <Animated.View key={d.id} layout={layout} exiting={exiting}>
      <DestinationRow
        server={d.server}
        expiryLabel={d.expiryLabel}
        compat={compatOf(d.server)}
        onRemove={() => remove([d])}
      />
    </Animated.View>
  ));

  // The list runs to the sheet's bottom edge; its own bottom padding clears the home indicator.
  const contentStyle = [styles.content, { paddingBottom: insets.bottom + Spacing.four }];

  const content: ReactNode = (
    <>
      {/* Leading-aligned like the app's other sheets; the close button floats at the top right. */}
      <View style={styles.headerText}>
        <ThemedText type="title2">Upload destinations</ThemedText>
        <ThemedText type="body" themeColor="textSecondary">
          Servers you’ve paired. Pick one when you upload.
        </ThemedText>
      </View>

      <View style={styles.list}>{rows}</View>

      {/* The app's destructive text action, centred below the list. Only for two or more: a single
          row already has its own trash. It moves with the rows as they reflow. */}
      {destinations.length > 1 && (
        <Animated.View layout={layout} exiting={exiting}>
          <DestructiveAction
            label="Remove all"
            accessibilityLabel="Remove all destinations"
            onPress={() => remove(destinations)}
          />
        </Animated.View>
      )}
    </>
  );

  return (
    // Not flattened into its children, so the sheet sees one subview. When it scrolls, the scroll
    // view is that subview's first child: iOS only expands a sheet from a scroll view on its
    // first-subview chain. The title scrolls with the rows; the close button stays put.
    // Light mode, expandable: iOS turns the glass solid white at full height, which sat oddly
    // against the grey it shows at 60%. The grouped background is that same grey, in both sizes.
    <View
      collapsable={false}
      style={
        scrolls
          ? [styles.fill, mode === 'light' && { backgroundColor: theme.groupedBackground }]
          : undefined
      }>
      {scrolls ? (
        <ScrollView contentContainerStyle={contentStyle}>{content}</ScrollView>
      ) : (
        <View style={contentStyle}>{content}</View>
      )}
      <Pressable
        onPress={() => router.back()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
        <Icon name="xmark.circle.fill" size={28} tintColor={theme.textSecondary} />
      </Pressable>
    </View>
  );
}

function DestinationRow({
  server,
  expiryLabel,
  compat,
  onRemove,
}: {
  server: string;
  expiryLabel: string;
  compat: ServerCompat | undefined;
  onRemove: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { backgroundColor: theme.card }]}>
      {/* The home pill's glyph and color: the row is a server, not an alert. */}
      <Icon name="icloud.and.arrow.up" size={18} tintColor={theme.text} />
      <View style={styles.rowText}>
        <DestinationLabel server={server} />
        {compat ? (
          <RowStatus compat={compat} expiryLabel={expiryLabel} />
        ) : (
          <ThemedText type="footnote" themeColor="textSecondary">
            {expiryLabel}
          </ThemedText>
        )}
      </View>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${hostOf(server)}`}
        style={({ pressed }) => [styles.delete, pressed && styles.pressed]}>
        <Icon name="trash" size={20} tintColor={theme.accent} />
      </Pressable>
    </View>
  );
}

/** Size of the status glyph, and of the box the checking spinner shrinks into. */
const STATUS_ICON = 13;
/** `ActivityIndicator size="small"`'s own box: it lays out at this size whatever its scale. */
const SPINNER_SIZE = 20;
/** The footnote line the status icon centers on (ThemedText's `footnote`). */
const FOOTNOTE_LINE = 18;

/**
 * The server's compatibility with this app, then the destination's expiry: "✓ protocol 2.3 · No
 * expiry". A check and its protocol when it works, else the problem in words — orange when the
 * server can't be reached (it may be back later), red when this app and it can't work together.
 *
 * One text, so it wraps rather than truncates and never runs into the trash button. The "·" is
 * glued to the status (no-break space) and the expiry to itself, so a wrap breaks after the "·",
 * never leaving it to start a line or splitting "Expires in 7d".
 */
function RowStatus({ compat, expiryLabel }: { compat: ServerCompat; expiryLabel: string }) {
  const theme = useTheme();
  // The icon stays on the first line's center when the text wraps; that line grows with text size.
  const { fontScale } = useWindowDimensions();
  const ok = compat.status === 'compatible';
  const checking = compat.status === 'checking';
  const color: ThemeColor =
    ok || checking ? 'textSecondary' : compat.status === 'unreachable' ? 'warning' : 'accent';
  return (
    <View
      style={styles.meta}
      accessible
      accessibilityLabel={`${compatLabel(compat)}, ${expiryLabel}`}>
      {/* One fixed box for the spinner and the icon that replaces it, so the text doesn't move. */}
      <View
        style={[
          styles.statusIcon,
          { marginTop: Math.max(0, (FOOTNOTE_LINE * fontScale - STATUS_ICON) / 2) },
        ]}>
        {checking ? (
          <ActivityIndicator size="small" color={theme.textSecondary} style={styles.spinner} />
        ) : (
          <Icon
            name={ok ? 'checkmark.circle.fill' : 'exclamationmark.triangle.fill'}
            size={STATUS_ICON}
            tintColor={theme[color]}
          />
        )}
      </View>
      <ThemedText type="footnote" themeColor="textSecondary" style={styles.metaText}>
        <ThemedText type="footnote" themeColor={color}>
          {ok ? `protocol ${compat.revision ?? compat.protocol}` : compatLabel(compat)}
        </ThemedText>
        {`\u00A0· ${expiryLabel.replace(/ /g, '\u00A0')}`}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: {
    gap: Spacing.three,
    paddingTop: Spacing.five,
    paddingHorizontal: Spacing.four,
  },
  // Room on the right for the floating close button.
  headerText: { gap: Spacing.one, paddingRight: Spacing.five },
  close: { position: 'absolute', top: Spacing.five, right: Spacing.four },
  list: { gap: Spacing.two },
  // A 20 pt line padded to 36 pt; with the hit slop, a 52 pt target. Only as wide as its label,
  // so a tap beside it doesn't remove everything.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    paddingLeft: Spacing.three,
    paddingRight: Spacing.two,
    borderRadius: Radius.card,
    borderCurve: 'continuous',
    ...CardShadow,
  },
  rowText: { flex: 1, gap: Spacing.half },
  meta: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.one },
  statusIcon: {
    width: STATUS_ICON,
    height: STATUS_ICON,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinner: { transform: [{ scale: STATUS_ICON / SPINNER_SIZE }] },
  metaText: { flexShrink: 1 },
  delete: { padding: Spacing.two },
  // The close, trash and Remove all buttons are bare glyphs and text.
  pressed: { opacity: Opacity.pressedGlyph },
});
