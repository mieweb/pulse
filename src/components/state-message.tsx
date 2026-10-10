import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { Icon, type IconName } from './icon';
import { ThemedText } from './themed-text';

/**
 * The app's one layout for an empty, loading-failed, error or permission moment: an icon, a
 * semibold title, a line of explanation and an optional action, centred. `tone` colours the icon:
 * `neutral` (nothing here yet), `accent` (something needs doing: an error, a permission).
 */
export function StateMessage({
  icon,
  title,
  message,
  tone = 'neutral',
  messageLines,
  children,
}: {
  icon?: IconName;
  title: string;
  message?: string;
  tone?: 'neutral' | 'accent';
  /** Caps the message (e.g. an error text whose length the app doesn't control). */
  messageLines?: number;
  /** The action(s) under the text, e.g. a PrimaryButton. */
  children?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={styles.wrap}>
      {icon && (
        <Icon
          name={icon}
          size={48}
          tintColor={tone === 'accent' ? theme.accent : theme.textSecondary}
        />
      )}
      <ThemedText type="title3" style={styles.title}>
        {title}
      </ThemedText>
      {message && (
        <ThemedText themeColor="textSecondary" numberOfLines={messageLines} style={styles.message}>
          {message}
        </ThemedText>
      )}
      {children && <View style={styles.actions}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.five,
  },
  title: { fontWeight: '600', textAlign: 'center' },
  message: { textAlign: 'center' },
  actions: { alignSelf: 'stretch', marginTop: Spacing.three, gap: Spacing.two },
});
