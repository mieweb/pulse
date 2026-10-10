import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { displayServer } from '@/utils/format';

/**
 * What a destination is called, the same wherever it's listed (destinations sheet rows, the export
 * picker's chips): the host app's own words when the pairing link carries them (`label` and
 * `app`, #252 §4: "Huddle feed · TimeHuddle") with the server under it, else just the server. The
 * server is its host plus any path (`displayServer`): two servers on one host differ only there.
 * Two pairings to one server can be different destinations, so the label is what tells them apart.
 */
export function DestinationLabel({
  server,
  label,
  app,
  size = 'row',
}: {
  server: string;
  label?: string | null;
  app?: string | null;
  /** `row` for the destinations sheet, `chip` for the export picker's narrower chips. */
  size?: 'row' | 'chip';
}) {
  const host = displayServer(server);
  const title = label ? (app ? `${label} · ${app}` : label) : host;
  const chip = size === 'chip';
  return (
    <View style={styles.label}>
      {/* The host keeps its domain's end visible ("…mieweb.org"); a label keeps its start. */}
      <ThemedText
        type={chip ? 'subheadlineEmphasized' : 'headline'}
        numberOfLines={1}
        ellipsizeMode={label ? 'tail' : 'middle'}>
        {title}
      </ThemedText>
      {label && (
        <ThemedText
          type={chip ? 'caption2' : 'footnote'}
          themeColor="textSecondary"
          numberOfLines={1}
          ellipsizeMode="middle">
          {host}
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { flexShrink: 1, gap: Spacing.half },
});
