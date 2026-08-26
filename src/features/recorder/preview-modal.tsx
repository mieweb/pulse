import { Icon } from '@/components/icon';
import { VideoView, type VideoPlayer } from 'expo-video';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { GlassPill } from '@/components/glass-pill';
import { Spacing } from '@/constants/theme';
import { formatDurationPadded } from '@/utils/format';

// Action badge diameter. With hitSlop 4 the effective tap target is 48pt (≥ the 44pt HIG
// minimum) while the ✂ and 🗑 hit areas — 8pt apart — still can't overlap.
const BADGE_SIZE = 40;
const BADGE_HIT_SLOP = 4;

type Props = {
  player: VideoPlayer;
  isPlaying: boolean;
  // Draft-global playhead position and total, for the time readout pill.
  positionMs: number;
  totalMs: number;
  onTogglePlay: () => void;
  onClose: () => void;
  onTrim: () => void;
  onDelete: () => void;
};

/**
 * Floating preview card over the recorder — the camera UI, record button, and segment bar
 * all stay visible around it. Plays the draft through one shared player; tap toggles play,
 * ✕ closes, ✂ opens the RNVT editor for the active clip, 🗑 deletes. `contentFit="contain"`
 * on black lets the native player honor each clip's rotation matrix (portrait upright).
 * No captions here — transcription now happens once on the merged video at export time.
 */
export function PreviewModal({
  player,
  isPlaying,
  positionMs,
  totalMs,
  onTogglePlay,
  onClose,
  onTrim,
  onDelete,
}: Props) {
  return (
    <View style={styles.card}>
      <Pressable style={styles.surface} onPress={onTogglePlay} accessibilityLabel="Toggle playback">
        <VideoView
          style={StyleSheet.absoluteFill}
          player={player}
          contentFit="contain"
          nativeControls={false}
        />
        {!isPlaying && (
          <View style={styles.playOverlay} pointerEvents="none">
            <GlassPill style={styles.playBadge}>
              <Icon name="play.fill" size={28} tintColor="#fff" />
            </GlassPill>
          </View>
        )}
      </Pressable>

      <Pressable
        onPress={onClose}
        hitSlop={BADGE_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel="Close preview"
        style={styles.close}>
        <GlassPill style={styles.badge}>
          <Icon name="xmark" size={18} weight="semibold" tintColor="#fff" />
        </GlassPill>
      </Pressable>

      <Pressable
        onPress={onTrim}
        hitSlop={BADGE_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel="Edit clip"
        style={styles.trim}>
        <GlassPill style={styles.badge}>
          <Icon name="scissors" size={20} weight="semibold" tintColor="#fff" />
        </GlassPill>
      </Pressable>

      <Pressable
        onPress={onDelete}
        hitSlop={BADGE_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel="Delete clip"
        style={styles.delete}>
        <GlassPill style={styles.badge}>
          <Icon name="trash" size={20} weight="semibold" tintColor="#fff" />
        </GlassPill>
      </Pressable>

      <View style={styles.timeRow} pointerEvents="none">
        <GlassPill style={styles.timePill}>
          <Text style={styles.timeText}>
            {formatDurationPadded(positionMs)} / {formatDurationPadded(totalMs)}
          </Text>
        </GlassPill>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '72%',
    aspectRatio: 9 / 16,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  surface: { flex: 1 },
  playOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Shape only — GlassPill owns the surface. paddingLeft optically centers the ▶ glyph.
  playBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 4,
  },
  // Badge shape only — GlassPill owns the surface (Liquid Glass on iOS 26+, dark scrim
  // fallback), so no backgroundColor here. Position lives on the wrapping Pressable.
  badge: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  close: {
    position: 'absolute',
    top: Spacing.two,
    left: Spacing.two,
  },
  delete: {
    position: 'absolute',
    top: Spacing.two,
    right: Spacing.two,
  },
  // Left of the delete badge (one badge width + an 8pt gap).
  trim: {
    position: 'absolute',
    top: Spacing.two,
    right: Spacing.two + BADGE_SIZE + Spacing.two,
  },
  timeRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: Spacing.two,
    alignItems: 'center',
  },
  // Shape only — GlassPill owns the surface, same as the badges above.
  timePill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 4,
    borderRadius: 12,
  },
  timeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.3,
  },
});
