import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { type ReactNode, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { SectionHeader } from '@/components/section-header';
import { SheetBody } from '@/components/sheet-body';
import { ThemedText } from '@/components/themed-text';
import { CardShadow, Opacity, Radius, Spacing } from '@/constants/theme';
import {
  commitLabel,
  readBuildInfo,
  versionLabel,
  type BuildConfig,
} from '@/features/about/build-info';
import { formatDetails, type DeviceInfo } from '@/features/about/details';
import { useServerCompatibility } from '@/features/about/use-server-compatibility';
import { logEntries, logExportText, writeLogExport } from '@/features/logs/logger';
import { useToast } from '@/features/toast/toast-provider';
import { APP_PROTOCOL, protocolRangeLabel } from '@/features/upload/client-identity';
import { useTheme } from '@/hooks/use-theme';
import { formatCount } from '@/utils/format';
import { formatDateTime } from '@/utils/relative-date';
import { tallSheetFits } from '@/utils/sheet-fit';
import { userMessage } from '@/utils/user-message';

const build = readBuildInfo(Constants.expoConfig as BuildConfig | null, Platform.OS);
const device: DeviceInfo = {
  os: Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : Platform.OS,
  osVersion: Device.osVersion,
  model: Device.modelName,
};

/** The app's sheet close control size (pairing, destinations, On-device AI). */
const CLOSE_ICON_SIZE = 28;

/** Copy details is a 20 pt line of text: the slop makes it a 44 pt target. */
const COPY_SLOP = { top: 12, bottom: 12, left: 8, right: 8 };

/** The generated compatibility table (GitHub Pages), with this app's row highlighted. */
const COMPATIBILITY_URL = `https://mieweb.github.io/pulse/compatibility.html?app=${encodeURIComponent(
  build.version,
)}&protocol=${APP_PROTOCOL.min}-${APP_PROTOCOL.max}`;

/**
 * About (#155): version, build number, commit and build date — all injected at build time by
 * `app.config.ts` — plus this app's upload protocol, whether each paired server is compatible,
 * and the debug log. Copy details and Share logs put all of it into one bug report.
 */
export default function AboutScreen() {
  const insets = useSafeAreaInsets();
  // Decided when the sheet opens, as its route options are (`tallSheetOptions`).
  const [scrolls] = useState(() => !tallSheetFits());
  const theme = useTheme();
  const { showToast } = useToast();
  // Still checked here: Copy details and the log export carry each server's result.
  const servers = useServerCompatibility();
  const [sharing, setSharing] = useState(false);
  const logCount = useMemo(() => logEntries().length, []);

  const details = () =>
    formatDetails({
      build,
      device,
      protocol: APP_PROTOCOL,
      servers,
    });

  const copyDetails = () => {
    // The whole bug report: the details, then the debug log (what Share logs sends as a file).
    void Clipboard.setStringAsync(logExportText(details())).then(
      (ok) =>
        ok && showToast({ title: 'Details copied', message: 'Paste them into your bug report.' }),
      () => showToast({ kind: 'error', title: 'Couldn’t copy the details', message: 'Try again.' }),
    );
  };

  const shareLogs = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      if (!(await isAvailableAsync())) throw new Error('Sharing isn’t available on this device.');
      const file = writeLogExport(details());
      await shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: 'Pulse logs' });
    } catch (e) {
      // As a failed copy: nothing to decide, so a toast rather than an alert.
      showToast({
        kind: 'error',
        title: 'Couldn’t share logs',
        message: userMessage(e, 'Try again.', 'share logs'),
      });
    } finally {
      setSharing(false);
    }
  };

  // The sheet's own glass is the background, as on the app's other sheets; the cards use their
  // row fill.
  const surface = { backgroundColor: theme.card };

  return (
    <View collapsable={false} style={styles.fill}>
      {/* No title bar: the app icon, name and version open the sheet, and the content flows on
          from there. The sheet sizes to it and doesn't scroll (a scroll view breaks a
          `fitToContents` sheet's layout); at large text sizes or on a short screen, where it would
          be clipped, it opens full height and scrolls instead (`tallSheetFits`). */}
      <SheetBody
        scrolls={scrolls}
        style={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        <View style={styles.hero}>
          {/* expo-image, not RN's Image: RN re-fetched and re-decoded the 1024px icon on every
              open (in dev, over Wi-Fi from Metro), so it popped in late or never showed. The
              memory+disk cache makes every open after the first instant. The icon's backdrop fades
              to pure white at the top, so without the hairline its top edge vanishes on a white
              sheet (the App Store outlines light icons the same way). */}
          <Image
            source={require('../../assets/images/icon.png')}
            style={[styles.appIcon, { borderColor: theme.border }]}
            cachePolicy="memory-disk"
          />
          <View style={styles.heroText}>
            <ThemedText type="title2">Pulse</ThemedText>
            <ThemedText themeColor="textSecondary">Version {versionLabel(build)}</ThemedText>
          </View>
        </View>

        <Section
          title="This build"
          surface={surface}
          action={
            <Pressable
              onPress={copyDetails}
              hitSlop={COPY_SLOP}
              accessibilityRole="button"
              accessibilityLabel="Copy details"
              accessibilityHint="Copies the build and server details and the debug log for a bug report"
              style={({ pressed }) => [styles.copy, pressed && styles.pressedIcon]}>
              <Icon name="doc.on.doc" size={14} weight="semibold" tintColor={theme.accent} />
              <ThemedText type="subheadlineEmphasized" themeColor="accent">
                Copy details
              </ThemedText>
            </Pressable>
          }>
          <Row label="Commit" value={commitLabel(build)} />
          <Row
            label="Built"
            // In the device's time zone: Hermes' own `toLocaleString` reads UTC and labels it
            // local.
            value={build.builtAt ? formatDateTime(build.builtAt.getTime()) : 'Unknown'}
          />
          <Row label="Built against PulseVault" value={build.pulsevault ?? 'Unknown'} />
          <Row
            label="Device"
            value={[device.model, [device.os, device.osVersion].filter(Boolean).join(' ')]
              .filter(Boolean)
              .join(' · ')}
            last
          />
        </Section>

        <Section title="Compatibility" surface={surface}>
          {/* Each paired server's own result is on its row in the destinations sheet (home). */}
          <Row label="Upload protocol" value={`v${protocolRangeLabel(APP_PROTOCOL)}`} />
          <Pressable
            onPress={() => void Linking.openURL(COMPATIBILITY_URL)}
            accessibilityRole="link"
            accessibilityLabel="Compatibility and docs"
            accessibilityHint="Opens which Pulse and PulseVault versions work together"
            style={({ pressed }) => [
              styles.inlineButton,
              pressed && { backgroundColor: theme.backgroundSelected },
            ]}>
            <Icon name="link" size={18} tintColor={theme.accent} />
            <ThemedText themeColor="accent">Compatibility & docs</ThemedText>
          </Pressable>
        </Section>

        <Section title="Debug logs" surface={surface}>
          <ThemedText type="footnote" themeColor="textSecondary" style={styles.note}>
            Recent app activity, kept on this device ({formatCount(logCount, 'entry', 'entries')}).
            Upload tokens are removed before anything is saved.
          </ThemedText>
          <Pressable
            onPress={() => void shareLogs()}
            disabled={sharing}
            accessibilityRole="button"
            accessibilityLabel="Share logs"
            accessibilityState={{ busy: sharing }}
            style={({ pressed }) => [
              styles.inlineButton,
              pressed && { backgroundColor: theme.backgroundSelected },
            ]}>
            {sharing ? (
              <ActivityIndicator size="small" color={theme.accent} />
            ) : (
              <Icon name="square.and.arrow.up" size={18} tintColor={theme.accent} />
            )}
            <ThemedText themeColor="accent">Share logs</ThemedText>
          </Pressable>
        </Section>
      </SheetBody>

      {/* The app's sheet close control, top right, level with the app icon. */}
      <Pressable
        onPress={() => router.back()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Close"
        style={({ pressed }) => [styles.close, pressed && styles.pressedIcon]}>
        <Icon name="xmark.circle.fill" size={CLOSE_ICON_SIZE} tintColor={theme.textSecondary} />
      </Pressable>
    </View>
  );
}

function Section({
  title,
  surface,
  action,
  children,
}: {
  title: string;
  surface: { backgroundColor: string };
  /** A small control at the right end of the section title (e.g. Copy). */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <SectionHeader title={title} action={action} />
      {/* The shadow sits on a wrapper: the card clips its rows to its corners, which would clip a
          shadow on the card itself. */}
      <View style={[styles.cardShadow, surface]}>
        <View style={styles.card}>{children}</View>
      </View>
    </View>
  );
}

function Row({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.row,
        !last && { borderBottomColor: theme.border, borderBottomWidth: StyleSheet.hairlineWidth },
      ]}
      accessible
      accessibilityLabel={`${label}: ${value}`}>
      <ThemedText style={styles.rowLabel}>{label}</ThemedText>
      <ThemedText themeColor="textSecondary" style={styles.rowValue} selectable>
        {value}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  close: { position: 'absolute', top: Spacing.five, right: Spacing.four },
  content: { paddingTop: Spacing.five, paddingHorizontal: Spacing.four, gap: Spacing.four },
  // Leading-aligned like the app's other sheets: the icon, then the name and version beside it.
  // Right padding keeps the text clear of the close button floating at the top right.
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingRight: Spacing.five,
  },
  heroText: { flex: 1, gap: Spacing.half },
  appIcon: {
    width: 64,
    height: 64,
    borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
  },
  section: { gap: Spacing.two },
  copy: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  cardShadow: { borderRadius: Radius.card, borderCurve: 'continuous', ...CardShadow },
  card: { borderRadius: Radius.card, borderCurve: 'continuous', overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: 12,
  },
  // The label keeps its words whole ("Devic / e" at a large text size); the value wraps.
  rowLabel: { flexShrink: 0 },
  rowValue: { flexShrink: 1, textAlign: 'right' },
  status: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one, flexShrink: 1 },
  note: { paddingHorizontal: Spacing.three, paddingTop: 12 },
  // A full-width row inside a card: it swaps its fill on press, as in-card rows do (the card's
  // overflow clipping rounds the fill at the card's corners), rather than dimming.
  inlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: 12,
  },
  // Copy details and the close button are bare glyphs and text.
  pressedIcon: { opacity: Opacity.pressedGlyph },
});
