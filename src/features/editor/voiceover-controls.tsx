import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/icon';
import { Accent } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import type { useVoiceover } from './use-voiceover';

export const VOICEOVER_CONTROLS_HEIGHT = 142;

/** Keep touch release events separate from the standard Start/Stop activation. */
export function voiceoverRecordingActions() {
  let held = false;
  return {
    resetHold: () => {
      held = false;
    },
    forVoiceover: (
      voiceover: Pick<ReturnType<typeof useVoiceover>, 'phase' | 'undoBusy' | 'press' | 'release'>,
    ) => {
      const { phase, undoBusy, press, release } = voiceover;
      const recording = phase === 'starting' || phase === 'recording';
      const waiting = phase === 'preparing' || phase === 'saving';
      const disabled = !recording && (phase !== 'ready' || undoBusy);
      const releaseHold = () => {
        if (!held) return;
        held = false;
        release();
      };
      return {
        hold: {
          onPressIn: () => {
            if (phase !== 'ready' || undoBusy) return;
            held = true;
            press();
          },
          // Use actual release only: Pressability's delayed onPressOut can outlive this take.
          onTouchEnd: releaseHold,
          onTouchCancel: releaseHold,
          disabled,
          // The adjacent Start/Stop button provides standard screen-reader and switch activation.
          accessible: false,
          accessibilityElementsHidden: true,
          importantForAccessibility: 'no-hide-descendants' as const,
          testID: 'voiceover.record',
        },
        toggle: {
          onPress: () => {
            if (disabled) return;
            if (recording) {
              held = false;
              release();
            } else {
              held = false;
              press();
            }
          },
          disabled,
          accessibilityRole: 'button' as const,
          accessibilityLabel: recording ? 'Stop recording voiceover' : 'Start recording voiceover',
          accessibilityHint: recording
            ? 'Saves this take and pauses the video.'
            : 'Starts narration while the video plays. Activate Stop to save this take and pause.',
          accessibilityState: { busy: waiting, disabled },
          testID: 'voiceover.toggle',
        },
      };
    },
  };
}

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
  const [recordingActions] = useState(voiceoverRecordingActions);
  useEffect(() => {
    // An interrupted hold may unmount before its touch-cancel event is delivered.
    if (phase === 'preparing' || phase === 'saving' || phase === 'failed')
      recordingActions.resetHold();
  }, [phase, recordingActions]);
  const actions = recordingActions.forVoiceover(voiceover);
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
        <View style={styles.recordingRow}>
          <Pressable
            {...actions.hold}
            style={[
              styles.record,
              styles.shortcut,
              { backgroundColor: recording ? Accent : theme.text },
            ]}>
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
                    ? 'Recording…'
                    : 'Hold to record'}
            </Text>
          </Pressable>
          <Pressable
            {...actions.toggle}
            style={[
              styles.record,
              styles.toggle,
              { backgroundColor: recording ? Accent : theme.backgroundElement },
              actions.toggle.disabled && styles.dim,
            ]}>
            <Text style={[styles.recordText, { color: recording ? '#fff' : theme.text }]}>
              {recording ? 'Stop' : 'Start'}
            </Text>
          </Pressable>
        </View>
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
  recordingRow: { flexDirection: 'row', gap: 8 },
  shortcut: { flex: 1 },
  toggle: { minWidth: 80 },
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
