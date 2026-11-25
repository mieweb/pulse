import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { GlassPill } from '@/components/glass-pill';
import { Accent, Opacity, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { formatDuration } from '@/utils/format';

/**
 * The screen take's own Stop, in its draft's recorder or editor: how long it has run, and a
 * tap anywhere on it stops it (the shutter stays the camera's); the red Stop inside is what reads
 * as the button. While the file settles Stop shows a spinner and takes no taps. Over video it
 * dims only what's inside the glass; on a flat editor background it uses the themed surface.
 */
export function ScreenStopPill({
  began,
  starting,
  stopping,
  onStop,
  overVideo = true,
}: {
  began: number | null;
  /** Record screen was tapped and the capture hasn't begun: a spinner, nothing to tap yet. */
  starting: boolean;
  stopping: boolean;
  onStop: () => void;
  /** False on the editor's flat background; the recorder keeps glass over its video. */
  overVideo?: boolean;
}) {
  const theme = useTheme();
  const Surface = overVideo ? GlassPill : View;
  const color = overVideo ? '#fff' : theme.text;
  const surfaceStyle = [styles.pill, !overVideo && { backgroundColor: theme.backgroundElement }];
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
      <Surface style={surfaceStyle} accessible accessibilityLabel="Starting screen recording">
        <View style={styles.status}>
          <ActivityIndicator size="small" color={color} />
          <Text style={[styles.text, { color }]} maxFontSizeMultiplier={1.3}>
            Starting…
          </Text>
        </View>
      </Surface>
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
        <Surface style={surfaceStyle}>
          <View style={styles.status}>
            <View style={styles.dot} />
            <Text style={[styles.text, { color }]} maxFontSizeMultiplier={1.3}>
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
        </Surface>
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
