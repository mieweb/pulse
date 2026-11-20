import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

/**
 * What a host write shows when this build doesn't run Pulse without a screen (no `headless`
 * capability, AD5 and O2): PulseKit presents it over the host for as long as the write takes (a
 * rename, or a Send that merges first), then closes it itself. It is the root's whole screen, on the
 * same black as PulseKit's container, so nothing flashes; the spinner is the only motion, and it
 * says that something is happening.
 */
export function Preparing() {
  return (
    <View
      style={styles.screen}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Preparing"
      accessibilityState={{ busy: true }}>
      <ActivityIndicator color="#ebebf5" />
      <Text style={styles.label}>Preparing…</Text>
    </View>
  );
}

// Over the container's dark skeleton, whatever the theme: the theme isn't loaded here.
const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    backgroundColor: '#000',
  },
  label: { fontSize: 17, color: '#ebebf5' },
});
