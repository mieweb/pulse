import { Icon } from '@/components/icon';
import { VideoView, type VideoPlayer } from 'expo-video';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { GlassPill } from '@/components/glass-pill';
import { Spacing } from '@/constants/theme';
import { formatDurationPadded } from '@/utils/format';

// Action badge diameter. With hitSlop 4 the effective tap target is 48pt (≥ the 44pt HIG
// minimum); the ✂ and 🗑 badges sit a full Spacing.five apart so their hit areas can't overlap.
const BADGE_SIZE = 40;
const BADGE_HIT_SLOP = 4;

type Props = {
  player: VideoPlayer;
  isPlaying: boolean;
  // Draft-global playhead position and total, for the time readout pill.
  positionMs: number;
  totalMs: number;
  onTogglePlay: () => void;
  onTrim: () => void;
  onDelete: () => void;
};

/**
 * Full-bleed preview stage over the recorder — fills the area between the top bar and the
 * segment bar on a black backdrop (the recorder blacks out the paused camera behind it).
 * Plays the draft through one shared player; tap toggles play, ✂ opens the RNVT editor for
 * the active clip, 🗑 deletes — both in a row below the video. Closing lives in the
 * recorder's top bar, so there's exactly one ✕ on screen. `contentFit="contain"` sizes the
 * video to the stage on ANY screen while preserving each clip's aspect ratio and letting the
 * native player honor its rotation matrix (portrait upright); the letterboxing disappears
 * into the black backdrop. No captions here — transcription now happens once on the merged
 * video at export time.
 */
export function PreviewModal({
  player,
  isPlaying,
  positionMs,
  totalMs,
  onTogglePlay,
  onTrim,
  onDelete,
}: Props) {
  return (
    <View style={styles.stage}>
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
        <View style={styles.timeRow} pointerEvents="none">
          <GlassPill style={styles.timePill}>
            <Text style={styles.timeText}>
              {formatDurationPadded(positionMs)} / {formatDurationPadded(totalMs)}
            </Text>
          </GlassPill>
        </View>
      </Pressable>

      <View style={styles.actionRow}>
        <Pressable
          onPress={onTrim}
          hitSlop={BADGE_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Edit clip">
          <GlassPill style={styles.badge}>
            <Icon name="scissors" size={20} weight="semibold" tintColor="#fff" />
          </GlassPill>
        </Pressable>
        <Pressable
          onPress={onDelete}
          hitSlop={BADGE_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Delete clip">
          <GlassPill style={styles.badge}>
            <Icon name="trash" size={20} weight="semibold" tintColor="#fff" />
          </GlassPill>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stage: {
    flex: 1,
    alignSelf: 'stretch',
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
  // fallback), so no backgroundColor here.
  badge: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.five,
    paddingVertical: Spacing.two,
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
