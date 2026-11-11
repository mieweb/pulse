import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { GlassPill } from '@/components/glass-pill';
import { Accent, Opacity, Spacing } from '@/constants/theme';
import { formatDuration } from '@/utils/format';

/**
 * The screen take's own Stop, in the recorder of the draft it goes to: how long it has run, and a
 * tap anywhere on it stops it (the shutter stays the camera's); the red Stop inside is what reads
 * as the button. While the file settles Stop shows a spinner and takes no taps. Dims only what's
 * inside the glass: a partly transparent ancestor draws it flat.
 */
export function ScreenStopPill({
  began,
  starting,
  stopping,
  onStop,
}: {
  began: number | null;
  /** Record screen was tapped and the capture hasn't begun: a spinner, nothing to tap yet. */
  starting: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  // Its own tick, so the clock re-renders this pill alone.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (stopping) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [stopping]);
  const elapsed = began == null ? 0 : now - began;

  if (starting) {
    return (
      <GlassPill style={styles.pill} accessible accessibilityLabel="Starting screen recording">
        <View style={styles.status}>
          <ActivityIndicator size="small" color="#fff" />
          <Text style={styles.text} maxFontSizeMultiplier={1.3}>
            Starting…
          </Text>
        </View>
      </GlassPill>
    );
  }

  return (
    <Pressable
      onPress={onStop}
      disabled={stopping}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel="Stop screen recording"
      accessibilityState={{ busy: stopping, disabled: stopping }}>
      {({ pressed }) => (
        <GlassPill style={styles.pill}>
          <View style={styles.status}>
            <View style={styles.dot} />
            <Text style={styles.text} maxFontSizeMultiplier={1.3}>
              {`Screen ${formatDuration(elapsed, { floor: true })}`}
            </Text>
          </View>
          {/* A filled button inside the status, so it reads as the thing to tap. */}
          <View
            style={[
              styles.stop,
              { opacity: stopping ? Opacity.disabled : pressed ? Opacity.pressed : 1 },
            ]}>
            {stopping ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <View style={styles.square} />
            )}
            <Text style={styles.stopText} maxFontSizeMultiplier={1.3}>
              Stop
            </Text>
          </View>
        </GlassPill>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: 44,
    borderRadius: 22,
    paddingLeft: Spacing.three,
    paddingRight: Spacing.one,
    minWidth: 120,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  status: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Accent },
  text: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  stop: {
    minHeight: 36,
    borderRadius: 18,
    paddingHorizontal: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    backgroundColor: Accent,
  },
  square: { width: 10, height: 10, borderRadius: 2, backgroundColor: '#fff' },
  stopText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
