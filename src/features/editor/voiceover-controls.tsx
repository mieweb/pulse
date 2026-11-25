import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/icon';
import { Accent } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import type { useVoiceover } from './use-voiceover';

export const VOICEOVER_CONTROLS_HEIGHT = 142;

export function VoiceoverControls({
  voiceover,
  onDone,
}: {
  voiceover: ReturnType<typeof useVoiceover>;
  onDone: () => void;
}) {
  const theme = useTheme();
  const { phase, busy, error, takes } = voiceover;
  const recording = phase === 'starting' || phase === 'recording';
  return (
    <View style={styles.root}>
      <View style={styles.row}>
        <Text style={[styles.title, { color: theme.text }]}>Voiceover</Text>
        <Pressable
          onPress={voiceover.undo}
          disabled={!voiceover.canUndo}
          accessibilityRole="button"
          accessibilityLabel="Undo last voiceover take"
          testID="voiceover.undo"
          style={[styles.action, !voiceover.canUndo && styles.dim]}>
          <Icon name="arrow.uturn.backward" size={17} tintColor={theme.text} />
          <Text style={{ color: theme.text }}>Undo take</Text>
        </Pressable>
        <Pressable
          onPress={onDone}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Done recording voiceover"
          testID="voiceover.done"
          style={styles.action}>
          <Icon name="checkmark" size={22} tintColor={theme.text} />
        </Pressable>
      </View>
      <View style={styles.row}>
        {(['source', 'voiceover'] as const).map((track) => {
          const muted = track === 'source' ? voiceover.sourceMuted : voiceover.voiceoverMuted;
          const label = track === 'source' ? 'Video audio' : 'Narration';
          return (
            <Pressable
              key={track}
              onPress={() => voiceover.toggleMute(track)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`${muted ? 'Unmute' : 'Mute'} ${label.toLowerCase()}`}
              accessibilityState={{ selected: muted, disabled: busy }}
              testID={`voiceover.mute.${track}`}
              style={styles.action}>
              <Icon
                name={muted ? 'speaker.slash.fill' : 'speaker.wave.2.fill'}
                size={16}
                tintColor={theme.text}
              />
              <Text style={[styles.small, { color: theme.text }]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      {phase === 'failed' ? (
        <Pressable
          onPress={voiceover.retry}
          accessibilityRole="button"
          accessibilityLabel="Retry voiceover"
          style={[styles.record, { backgroundColor: theme.backgroundElement }]}>
          <Text numberOfLines={2} style={[styles.small, { color: theme.text }]}>
            {error} Retry
          </Text>
        </Pressable>
      ) : (
        <Pressable
          onPressIn={voiceover.press}
          onPressOut={voiceover.release}
          // Pressability keeps very short presses highlighted for 130 ms. End capture on the
          // actual touch release too; duplicate release callbacks share the same finish task.
          onTouchEnd={voiceover.release}
          onTouchCancel={voiceover.release}
          disabled={phase === 'preparing' || phase === 'saving' || voiceover.undoBusy}
          accessibilityRole="button"
          accessibilityLabel="Hold to record voiceover"
          accessibilityHint="Press and hold to narrate while the video plays. Release to save this take and pause."
          accessibilityState={{
            busy: phase === 'preparing' || phase === 'saving',
            disabled: phase === 'preparing' || phase === 'saving',
          }}
          testID="voiceover.record"
          style={[styles.record, { backgroundColor: recording ? Accent : theme.text }]}>
          {phase === 'preparing' || phase === 'saving' ? (
            <ActivityIndicator size="small" color={theme.background} />
          ) : (
            <Icon name="mic.fill" size={20} tintColor={recording ? '#fff' : theme.background} />
          )}
          <Text style={[styles.recordText, { color: recording ? '#fff' : theme.background }]}>
            {phase === 'preparing'
              ? 'Preparing microphone…'
              : phase === 'saving'
                ? 'Saving take…'
                : recording
                  ? 'Recording · release to save'
                  : 'Hold to record'}
          </Text>
        </Pressable>
      )}
      <Text numberOfLines={1} style={[styles.hint, { color: theme.textSecondary }]}>
        {error && phase !== 'failed'
          ? error
          : `${takes.length} ${takes.length === 1 ? 'take' : 'takes'} · Scrub to position · Video audio silent while recording`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: 16, gap: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 28,
  },
  title: { fontSize: 16, fontWeight: '600', flex: 1 },
  action: {
    minHeight: 30,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  small: { fontSize: 12 },
  record: {
    minHeight: 44,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  recordText: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 11, textAlign: 'center' },
  dim: { opacity: 0.35 },
});
