import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import { isAvailableAsync, shareAsync } from 'expo-sharing';
import { type ReactNode, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import {
  commitLabel,
  readBuildInfo,
  versionLabel,
  type BuildConfig,
} from '@/features/about/build-info';
import {
  compatLabel,
  formatDetails,
  type DeviceInfo,
  type ServerCompat,
} from '@/features/about/details';
import { useServerCompatibility } from '@/features/about/use-server-compatibility';
import { logEntries, writeLogExport } from '@/features/logs/logger';
import { CloseButton } from '@/features/recorder/close-button';
import { useToast } from '@/features/toast/toast-provider';
import { APP_PROTOCOL, protocolRangeLabel } from '@/features/upload/client-identity';
import { useTheme } from '@/hooks/use-theme';

const build = readBuildInfo(Constants.expoConfig as BuildConfig | null, Platform.OS);
const device: DeviceInfo = {
  os: Platform.OS === 'ios' ? 'iOS' : Platform.OS === 'android' ? 'Android' : Platform.OS,
  osVersion: Device.osVersion,
  model: Device.modelName,
};

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
  const theme = useTheme();
  const { showToast } = useToast();
  const servers = useServerCompatibility();
  const [sharing, setSharing] = useState(false);
  const logCount = useMemo(() => logEntries().length, []);

  const details = () => formatDetails({ build, device, protocol: APP_PROTOCOL, servers });

  const copyDetails = () => {
    void Clipboard.setStringAsync(details()).then(
      (ok) => ok && showToast('Details copied'),
      () => showToast("Couldn't copy the details"),
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
      Alert.alert('Couldn’t share logs', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setSharing(false);
    }
  };

  const surface = { backgroundColor: theme.backgroundElement, borderColor: theme.border };

  return (
    <ThemedView style={styles.fill}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.two }]}>
        <ThemedText type="subtitle">About</ThemedText>
        <CloseButton onPress={() => router.back()} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        <View style={styles.hero}>
          <Image source={require('../../assets/images/icon.png')} style={styles.appIcon} />
          <ThemedText type="title3">Pulse</ThemedText>
          <ThemedText themeColor="textSecondary">Version {versionLabel(build)}</ThemedText>
        </View>

        <Section title="This build" surface={surface}>
          <Row label="Commit" value={commitLabel(build)} />
          <Row
            label="Built"
            value={
              build.builtAt
                ? build.builtAt.toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })
                : 'Unknown'
            }
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
          <Row label="Upload protocol" value={`v${protocolRangeLabel(APP_PROTOCOL)}`} />
          {servers.length === 0 ? (
            <ThemedText type="caption1" themeColor="textSecondary" style={styles.note}>
              No servers paired yet.
            </ThemedText>
          ) : (
            servers.map((s) => <ServerRow key={s.server} compat={s} />)
          )}
          <Pressable
            onPress={() => void Linking.openURL(COMPATIBILITY_URL)}
            accessibilityRole="link"
            accessibilityLabel="Compatibility and docs"
            accessibilityHint="Opens which Pulse and PulseVault versions work together"
            style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed]}>
            <Icon name="link" size={18} tintColor={theme.accent} />
            <ThemedText themeColor="accent">Compatibility & docs</ThemedText>
          </Pressable>
        </Section>

        <Section title="Debug logs" surface={surface}>
          <ThemedText type="caption1" themeColor="textSecondary" style={styles.note}>
            Recent app activity, kept on this device ({logCount} entries). Upload tokens are removed
            before anything is saved.
          </ThemedText>
          <Pressable
            onPress={() => void shareLogs()}
            disabled={sharing}
            accessibilityRole="button"
            accessibilityLabel="Share logs"
            accessibilityState={{ busy: sharing }}
            style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed]}>
            {sharing ? (
              <ActivityIndicator size="small" color={theme.accent} />
            ) : (
              <Icon name="square.and.arrow.up" size={18} tintColor={theme.accent} />
            )}
            <ThemedText themeColor="accent">Share logs</ThemedText>
          </Pressable>
        </Section>

        <Pressable
          onPress={copyDetails}
          accessibilityRole="button"
          accessibilityLabel="Copy details"
          accessibilityHint="Copies the version, build and compatibility details for a bug report"
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: theme.accent },
            pressed && styles.pressed,
          ]}>
          <Icon name="doc.on.doc" size={18} tintColor={theme.onAccent} />
          <ThemedText style={{ color: theme.onAccent }}>Copy details</ThemedText>
        </Pressable>
      </ScrollView>
    </ThemedView>
  );
}

function Section({
  title,
  surface,
  children,
}: {
  title: string;
  surface: { backgroundColor: string; borderColor: string };
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <ThemedText type="caption1" themeColor="textSecondary" style={styles.sectionTitle}>
        {title.toUpperCase()}
      </ThemedText>
      <View style={[styles.card, surface]}>{children}</View>
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

/** A paired server and its compatibility. Always followed by the docs link, so it keeps its divider. */
function ServerRow({ compat }: { compat: ServerCompat }) {
  const theme = useTheme();
  const ok = compat.status === 'compatible';
  const checking = compat.status === 'checking';
  return (
    <View
      style={[
        styles.row,
        { borderBottomColor: theme.border, borderBottomWidth: StyleSheet.hairlineWidth },
      ]}
      accessible
      accessibilityLabel={`${compat.host}: ${compatLabel(compat)}`}>
      <ThemedText style={styles.rowLabel} numberOfLines={1}>
        {compat.host}
      </ThemedText>
      <View style={styles.status}>
        {checking ? (
          <ActivityIndicator size="small" color={theme.textSecondary} />
        ) : (
          <Icon
            name={ok ? 'checkmark.circle.fill' : 'exclamationmark.triangle.fill'}
            size={16}
            tintColor={ok ? theme.text : theme.accent}
          />
        )}
        <ThemedText type="caption1" themeColor="textSecondary">
          {compatLabel(compat)}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  content: { paddingHorizontal: Spacing.three, gap: Spacing.four },
  hero: { alignItems: 'center', gap: Spacing.one, marginTop: Spacing.two },
  appIcon: { width: 72, height: 72, borderRadius: 16, marginBottom: Spacing.two },
  section: { gap: Spacing.two },
  sectionTitle: { marginLeft: Spacing.three, letterSpacing: 0.5 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: 12,
  },
  rowLabel: { flexShrink: 1 },
  rowValue: { flexShrink: 1, textAlign: 'right' },
  status: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one, flexShrink: 1 },
  note: { paddingHorizontal: Spacing.three, paddingTop: 12 },
  inlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: 12,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    height: 52,
    borderRadius: 14,
  },
  pressed: { opacity: 0.85 },
});
