import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { compatLabel, type ServerCompat } from '@/features/about/details';
import { useServerCompatibility } from '@/features/about/use-server-compatibility';
import { ThemedText } from '@/components/themed-text';
import { CardShadow, Spacing } from '@/constants/theme';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
import { hostOf, shortHost } from '@/utils/format';
import { tallSheetFits } from '@/utils/sheet-fit';

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
 * Whether the sheet opens in its scrolling 60% → full-height mode: past `MAX_FITTED` rows, or at
 * any count when large text or a short screen would clip a fitted sheet (`tallSheetFits`).
 */
function scrollsFor(count: number): boolean {
  return count > MAX_FITTED || !tallSheetFits();
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

  const confirmDelete = (id: string, host: string) => {
    Alert.alert('Remove destination?', `Stop uploading to “${shortHost(host)}” from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void deleteDestination(id) },
    ]);
  };

  const confirmClearAll = () => {
    const count = destinations.length;
    Alert.alert(
      'Remove all destinations?',
      `Stop uploading to ${count === 1 ? 'this server' : `these ${count} servers`} from this device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove all',
          style: 'destructive',
          // The sheet closes itself once the pool is empty.
          onPress: () => void Promise.all(destinations.map((d) => deleteDestination(d.id))),
        },
      ],
    );
  };

  const rows = destinations.map((d) => (
    <DestinationRow
      key={d.id}
      server={d.server}
      expiryLabel={d.expiryLabel}
      compat={compatOf(d.server)}
      onRemove={(host) => confirmDelete(d.id, host)}
    />
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

      {/* Clear all, at the right above the list; the rows speak for themselves. */}
      <View style={styles.listHeader}>
        <Pressable
          onPress={confirmClearAll}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Remove all destinations"
          style={({ pressed }) => pressed && styles.pressed}>
          <ThemedText type="caption1" themeColor="accent" style={styles.clearLabel}>
            Clear all
          </ThemedText>
        </Pressable>
      </View>

      <View style={styles.list}>{rows}</View>
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
  onRemove: (host: string) => void;
}) {
  const theme = useTheme();
  const host = hostOf(server);
  return (
    <View style={[styles.row, { backgroundColor: theme.card }]}>
      <Icon name="icloud.and.arrow.up" size={17} weight="semibold" tintColor={theme.accent} />
      <View style={styles.rowText}>
        <DestinationLabel server={server} />
        {/* Compatibility first, then the expiry: "✓ protocol 2.3 · No expiry". Wraps rather than
            truncates, so a longer status is never cut off. */}
        <View style={styles.meta}>
          {compat && <CompatStatus compat={compat} />}
          <ThemedText type="footnote" themeColor="textSecondary">
            {compat ? `· ${expiryLabel}` : expiryLabel}
          </ThemedText>
        </View>
      </View>
      <Pressable
        onPress={() => onRemove(host)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${host}`}
        style={({ pressed }) => [styles.delete, pressed && styles.pressed]}>
        <Icon name="trash" size={20} tintColor={theme.accent} />
      </Pressable>
    </View>
  );
}

/**
 * The server's compatibility with this app: a check and its protocol when it works (the check says
 * "compatible"), else the problem in words.
 */
function CompatStatus({ compat }: { compat: ServerCompat }) {
  const theme = useTheme();
  const ok = compat.status === 'compatible';
  return (
    <View style={styles.compat} accessible accessibilityLabel={compatLabel(compat)}>
      {compat.status === 'checking' ? (
        <ActivityIndicator size="small" color={theme.textSecondary} style={styles.compatIcon} />
      ) : (
        <Icon
          name={ok ? 'checkmark.circle.fill' : 'exclamationmark.triangle.fill'}
          size={13}
          tintColor={ok ? theme.textSecondary : theme.accent}
        />
      )}
      <ThemedText type="footnote" themeColor={ok ? 'textSecondary' : 'accent'}>
        {ok ? `protocol ${compat.revision ?? compat.protocol}` : compatLabel(compat)}
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
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: Spacing.three,
    marginBottom: -Spacing.one,
  },
  clearLabel: { fontWeight: '600' },
  list: { gap: Spacing.two },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.three,
    paddingLeft: Spacing.three,
    paddingRight: Spacing.two,
    borderRadius: 18,
    ...CardShadow,
  },
  rowText: { flex: 1, gap: Spacing.half },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: Spacing.one },
  compat: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  compatIcon: { transform: [{ scale: 0.7 }] },
  delete: { padding: Spacing.two },
  pressed: { opacity: 0.6 },
});
