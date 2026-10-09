import { ClipboardPasteButton } from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { PrimaryButton } from '@/components/primary-button';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { hasNonAsciiHost } from '@/utils/format';

import { usePairingSheet } from './upload-deep-link-provider';

const BUTTON_HEIGHT = 50;

/**
 * The pairing sheet (#252), one layout for both ways a pairing arrives:
 * - `confirm`: a link was opened (or Android's install referrer handed one over). Shows the
 *   server and asks before Pulse contacts it (TOFU, PROTOCOL.md §3). "Don't ask again" trusts
 *   that server, so its later links pair without the sheet (trusted-servers.ts).
 * - `paste`: iOS first launch after a store install. Apple's paste button reads the link "Get
 *   Pulse" copied on the tap itself (no "Allow Paste" prompt; iOS fixes its label) and pairs
 *   straight away: the person chose that link on the page, which named the server.
 */
export function PairingSheet() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { request, connect, pairPasted, cancel, closed } = usePairingSheet();

  const [dontAsk, setDontAsk] = useState(false);

  // Swiped down without an answer: tell the provider which request went unanswered. Read through
  // refs so this runs on unmount only, not each time the provider hands over new callbacks.
  const shown = useRef(request);
  const onClosed = useRef(closed);
  const answered = useRef(false);
  useEffect(() => {
    if (request) shown.current = request;
    onClosed.current = closed;
  }, [request, closed]);
  useEffect(
    () => () => {
      if (!answered.current && shown.current) onClosed.current(shown.current);
    },
    [],
  );
  const answer = (action: () => void) => () => {
    answered.current = true;
    action();
  };

  if (!request) return null;
  const isPaste = request.kind === 'paste';

  return (
    <View
      collapsable={false}
      style={[styles.container, { paddingBottom: insets.bottom + Spacing.four }]}>
      {/* Leading-aligned like the app's other sheets; the buttons stay centered. */}
      <ThemedText type="title2">
        {isPaste ? 'Finish pairing' : 'Connect to this server?'}
      </ThemedText>

      {/* What pairs: the server, or (paste) the link, whose server Pulse can't see until the tap. */}
      <View style={[styles.server, { backgroundColor: theme.backgroundElement }]}>
        <Icon
          name={isPaste ? 'link' : 'icloud.and.arrow.up'}
          size={17}
          weight="semibold"
          tintColor={theme.accent}
        />
        {/* The whole host, never shortened: its end is exactly what a look-alike changes
            ("pulsevault.os.mieweb.org.evil-site.example"), so it wraps instead. */}
        <ThemedText type="headline" style={styles.serverHost}>
          {request.kind === 'confirm' ? request.host : 'The link you copied'}
        </ThemedText>
      </View>

      {/* A host with non-ASCII letters, or their punycode ("xn--"), can pass for another name. */}
      {request.kind === 'confirm' &&
        (hasNonAsciiHost(request.host) || /(^|\.)xn--/i.test(request.host)) && (
          <ThemedText type="footnote" themeColor="warning">
            This address contains unusual characters. It may imitate another server’s name.
          </ThemedText>
        )}

      <ThemedText type="body" themeColor="textSecondary">
        {isPaste
          ? 'Paste the link you copied before installing to connect.'
          : 'Your videos will upload here. Only connect if you recognize it.'}
      </ThemedText>

      {!isPaste && (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: dontAsk }}
          hitSlop={Spacing.two}
          onPress={() => setDontAsk((v) => !v)}
          style={styles.dontAsk}>
          <Icon
            name={dontAsk ? 'checkmark.circle.fill' : 'circle'}
            size={22}
            tintColor={dontAsk ? theme.accent : theme.textSecondary}
          />
          <ThemedText type="body">Don’t ask again for this server</ThemedText>
        </Pressable>
      )}

      {isPaste ? (
        <View style={styles.actions}>
          <ClipboardPasteButton
            acceptedContentTypes={['url', 'plain-text']}
            displayMode="iconAndLabel"
            cornerStyle="capsule"
            backgroundColor={theme.accent}
            foregroundColor="#ffffff"
            style={styles.button}
            onPress={(data) => {
              answered.current = true;
              pairPasted(data.type === 'text' ? data.text : '');
            }}
          />
          <Pressable
            accessibilityRole="button"
            hitSlop={Spacing.two}
            onPress={answer(cancel)}
            style={styles.cancel}>
            <ThemedText type="body" themeColor="textSecondary">
              Cancel
            </ThemedText>
          </Pressable>
        </View>
      ) : (
        // The app's paired actions: side by side in one row, the choice on the right. (Paste
        // keeps Apple's own button, whose size and shape iOS fixes.)
        <View style={styles.pair}>
          <PrimaryButton
            variant="card"
            label="Cancel"
            onPress={answer(cancel)}
            style={styles.pairButton}
          />
          <PrimaryButton
            label="Connect"
            onPress={answer(() => connect(dontAsk))}
            style={styles.pairButton}
          />
        </View>
      )}

      {isPaste && (
        // Centered with the Paste button it explains.
        <ThemedText type="footnote" themeColor="textSecondary" style={styles.footnote}>
          Pulse reads your clipboard only when you tap Paste.
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'flex-start',
    gap: Spacing.three,
    paddingTop: Spacing.five,
    paddingHorizontal: Spacing.four,
  },
  footnote: { alignSelf: 'stretch', textAlign: 'center' },
  server: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    maxWidth: '100%',
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    // Not a capsule: a long host wraps to a second line.
    borderRadius: Radius.button,
    borderCurve: 'continuous',
  },
  serverHost: { flexShrink: 1 },
  actions: { alignSelf: 'stretch', alignItems: 'center', gap: Spacing.two, marginTop: Spacing.two },
  button: { alignSelf: 'stretch', height: BUTTON_HEIGHT },
  pair: { alignSelf: 'stretch', flexDirection: 'row', gap: Spacing.two, marginTop: Spacing.two },
  pairButton: { flex: 1 },
  cancel: { paddingVertical: Spacing.two, paddingHorizontal: Spacing.four },
  dontAsk: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
});
