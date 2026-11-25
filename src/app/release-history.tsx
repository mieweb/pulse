import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { CardShadow, Opacity, Radius, Spacing } from '@/constants/theme';
import { ReleaseNoteList } from '@/features/about/release-note-list';
import { readReleaseNotes, releaseDateLabel } from '@/features/about/release-notes';
import { useTheme } from '@/hooks/use-theme';

const releases = readReleaseNotes(Constants.expoConfig).history;

export default function ReleaseHistoryScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.fill}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.four }]}>
        <ThemedText type="title2" accessibilityRole="header" style={styles.title}>
          Release history
        </ThemedText>
        <ThemedText themeColor="textSecondary">
          Previous releases included with this build of Pulse.
        </ThemedText>
        {releases.length === 0 ? (
          <ThemedText themeColor="textSecondary">
            Release history isn’t available for this build.
          </ThemedText>
        ) : (
          releases.map((release) => (
            <View key={release.version} style={[styles.card, { backgroundColor: theme.card }]}>
              <View style={styles.releaseHeader}>
                <ThemedText type="headline" accessibilityRole="header">
                  Version {release.version}
                </ThemedText>
                {releaseDateLabel(release.date) && (
                  <ThemedText type="footnote" themeColor="textSecondary">
                    {releaseDateLabel(release.date)}
                  </ThemedText>
                )}
              </View>
              <ReleaseNoteList release={release} />
            </View>
          ))
        )}
      </ScrollView>
      <Pressable
        onPress={() => router.back()}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Close release history"
        accessibilityHint="Returns to the version screen"
        style={({ pressed }) => [styles.close, pressed && { opacity: Opacity.pressedGlyph }]}>
        <Icon name="xmark.circle.fill" size={28} tintColor={theme.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: Spacing.four, gap: Spacing.three },
  title: { paddingRight: Spacing.five },
  close: { position: 'absolute', top: Spacing.four, right: Spacing.four },
  card: { borderRadius: Radius.card, borderCurve: 'continuous', ...CardShadow },
  releaseHeader: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three, gap: Spacing.half },
});
