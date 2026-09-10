import { Icon } from '@/components/icon';
import { VideoView, type VideoPlayer } from 'expo-video';
import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { GlassPill } from '@/components/glass-pill';
import { ControlScrim, Spacing } from '@/constants/theme';
import type { Segment } from '@/db/schema';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
import { useThumbnail } from '@/hooks/use-thumbnail';
import { formatDurationPadded } from '@/utils/format';

// Action badge diameter. With hitSlop 4 the effective tap target is 48pt (≥ the 44pt HIG
// minimum); the ✂ and 🗑 badges sit a full Spacing.five apart so their hit areas can't overlap.
const BADGE_SIZE = 40;
const BADGE_HIT_SLOP = 4;

type Props = {
  player: VideoPlayer;
  isPlaying: boolean;
  /** The active clip — its thumbnail provides the displayed aspect ratio for the frame. */
  segment: Segment;
  // Draft-global playhead position and total, for the time readout pill.
  positionMs: number;
  totalMs: number;
  onTogglePlay: () => void;
  onTrim: () => void;
  onDelete: () => void;
};

/**
 * The displayed aspect ratio of a clip, read from its first-frame thumbnail — thumbnails are
 * RENDERED frames, so rotation is already applied. The player's own `videoTrack.size` can't be
 * used: on iOS it's AVFoundation's un-rotated naturalSize, which reports portrait recordings
 * as landscape. Holds the last known ratio across clip switches so the frame doesn't flicker
 * to full-bleed while the next thumbnail resolves.
 */
function useVideoAspect(segment: Segment): number | null {
  const thumb = useThumbnail(segment.thumbnail, segment.editedFilename ?? segment.originalFilename);
  // Persisted jpeg thumbs need an async size read; the legacy VideoThumbnail fallback
  // carries width/height and is derived directly below.
  const [uriAr, setUriAr] = useState<number | null>(null);
  useEffect(() => {
    if (!thumb || !('uri' in thumb)) return;
    let alive = true;
    Image.getSize(
      thumb.uri,
      (w, h) => {
        if (alive && w > 0 && h > 0) setUriAr(w / h);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [thumb]);
  if (thumb && !('uri' in thumb) && thumb.width > 0 && thumb.height > 0)
    return thumb.width / thumb.height;
  return uriAr;
}

/**
 * Full-bleed preview stage over the recorder — fills the area between the top bar and the
 * segment bar on a themed backdrop (the recorder covers the paused camera with the theme
 * background). Plays the draft through one shared player; tap toggles play, ✂ opens the RNVT
 * editor for the active clip, 🗑 deletes — both in a row below the video. Closing lives in the
 * recorder's top bar, so there's exactly one ✕ on screen. The video renders inside a
 * hairline frame sized to its true display aspect (from the clip thumbnail) so black footage
 * stays visible against the backdrop; `contentFit="contain"` lets the native player honor
 * each clip's rotation matrix (portrait upright). No captions here — transcription now
 * happens once on the merged video at export time.
 */
export function PreviewModal({
  player,
  isPlaying,
  segment,
  positionMs,
  totalMs,
  onTogglePlay,
  onTrim,
  onDelete,
}: Props) {
  const aspect = useVideoAspect(segment);
  const theme = useTheme();
  const mode = useThemeMode();
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  // The frame hugs the video exactly: the clip's display aspect fitted into the measured
  // stage box. Null (no layout / no thumbnail yet) falls back to filling the stage.
  const frameSize = useMemo(() => {
    if (!box || !aspect) return null;
    const w = Math.min(box.w, box.h * aspect);
    return { width: w, height: w / aspect };
  }, [box, aspect]);

  return (
    <View style={[styles.stage, { backgroundColor: theme.background }]}>
      <Pressable
        style={styles.surface}
        onPress={onTogglePlay}
        onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        accessibilityRole="button"
        accessibilityLabel="Toggle playback">
        <View
          style={[styles.frame, { borderColor: theme.border }, frameSize ?? styles.frameFill]}
          pointerEvents="none">
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
        </View>
      </Pressable>

      <View style={styles.actionRow}>
        <Pressable
          onPress={onTrim}
          hitSlop={BADGE_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Edit clip">
          {/* Mode-aware scrim, not GlassPill: these sit on the THEMED backdrop, where glass
              has nothing to refract and a fixed dark scrim vanishes in dark mode. */}
          <View style={[styles.badge, ControlScrim[mode]]}>
            <Icon name="scissors" size={20} weight="semibold" tintColor="#fff" />
          </View>
        </Pressable>
        <Pressable
          onPress={onDelete}
          hitSlop={BADGE_HIT_SLOP}
          accessibilityRole="button"
          accessibilityLabel="Delete clip">
          <View style={[styles.badge, ControlScrim[mode]]}>
            <Icon name="trash" size={20} weight="semibold" tintColor="#fff" />
          </View>
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
  // Measured box the frame centers in; small side margins keep the frame off screen edges.
  surface: {
    flex: 1,
    marginHorizontal: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Hairline frame hugging the video rect so black footage stays legible against the
  // themed backdrop; border color comes from the theme (see render).
  frame: {
    borderRadius: Spacing.three,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  // Until the aspect/layout is known, fill the stage (the video letterboxes inside).
  frameFill: { alignSelf: 'stretch', flex: 1 },
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
  // Badge shape — the action row pairs it with the mode-aware ControlScrim fill; the play
  // badge over the video keeps GlassPill.
  badge: {
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    borderWidth: StyleSheet.hairlineWidth,
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
