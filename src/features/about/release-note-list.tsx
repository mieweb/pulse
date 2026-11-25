import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';

import type { ReleaseNote } from './release-notes';

/** The same complete summaries on About and in release history, with Dynamic Type wrapping. */
export function ReleaseNoteList({ release }: { release: ReleaseNote | null }) {
  return (
    <View style={styles.list}>
      {!release ? (
        <ThemedText themeColor="textSecondary">
          Release notes aren’t available for this build.
        </ThemedText>
      ) : release.notes.length === 0 ? (
        <ThemedText themeColor="textSecondary">
          No additional changes were recorded for this release.
        </ThemedText>
      ) : (
        release.notes.map((note, index) => (
          <View key={`${index}-${note}`} style={styles.row} accessible accessibilityLabel={note}>
            <ThemedText themeColor="textSecondary" accessible={false}>
              •
            </ThemedText>
            <ThemedText style={styles.text} accessible={false}>
              {note}
            </ThemedText>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: Spacing.two, padding: Spacing.three },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.two },
  text: { flex: 1 },
});
