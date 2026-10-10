import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Spacing } from '@/constants/theme';

import { ThemedText } from './themed-text';

/**
 * The app's one section heading above a card or list (About's sections, export's Upload, On-device
 * AI's captions models): small uppercase secondary text, inset to the card's content, with an
 * optional small action at the right end.
 */
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.header}>
      <ThemedText
        type="caption1"
        themeColor="textSecondary"
        accessibilityRole="header"
        style={styles.title}>
        {title.toUpperCase()}
      </ThemedText>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
  },
  title: { letterSpacing: 0.5 },
});
