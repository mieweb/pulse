import { Icon } from '@/components/icon';
import { useEvent } from 'expo';
import { Image as ExpoImage } from 'expo-image';
import { VideoView, type VideoPlayer } from 'expo-video';
import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { ZoomIn, ZoomOut } from 'react-native-reanimated';

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

// The ▶ badge appears only after playback has been parked this long. Clip switches and
// auto-advance pass through short "parked" windows the status can't distinguish (the old
// item's readyToPlay lingers a few frames until the next load flips it, and readyToPlay →
// playingChange has its own gap) — gating on held-time hides all of them.
const PARK_BADGE_DELAY_MS = 150;
// How long the transient ⏸ flash holds after playback starts before its fade-out begins.
const PAUSE_FLASH_HOLD_MS = 600;

// Frame outline per mode — stronger than theme.border so the video edge reads clearly
// against the flat backdrop (dark footage in dark mode especially).
const FRAME_BORDER = { light: 'rgba(0,0,0,0.3)', dark: 'rgba(255,255,255,0.3)' } as const;

type Props = {
  player: VideoPlayer;
  isPlaying: boolean;
  /** The active clip — its thumbnail provides the displayed aspect ratio for the frame. */
  segment: Segment;
  /** True while the bar playhead is being dragged — suppresses the play badge. */
  scrubbing?: boolean;
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
 * to full-bleed while the next thumbnail resolves. Also hands back the thumbnail itself —
 * the stage uses the same frame as a loading cover over the video.
 */
function useVideoAspect(segment: Segment) {
  const thumb = useThumbnail(segment.thumbnail, segment.editedFilename ?? segment.originalFilename);
  // Persisted jpeg thumbs need an async size read; the legacy VideoThumbnail fallback
  // carries width/height and is derived directly below. Keyed on the URI STRING — the hook
  // returns a fresh { uri } object each render, and the preview re-renders at the playhead's
  // cadence, so an object dep would re-run getSize several times a second.
  const thumbUri = thumb && 'uri' in thumb ? thumb.uri : null;
  const [uriAr, setUriAr] = useState<number | null>(null);
  useEffect(() => {
    if (!thumbUri) return;
    let alive = true;
    Image.getSize(
      thumbUri,
      (w, h) => {
        if (alive && w > 0 && h > 0) setUriAr(w / h);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [thumbUri]);
  const legacyAr =
    thumb && !('uri' in thumb) && thumb.width > 0 && thumb.height > 0
      ? thumb.width / thumb.height
      : null;
  return { aspect: legacyAr ?? uriAr, thumb };
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
  scrubbing = false,
  positionMs,
  totalMs,
  onTogglePlay,
  onTrim,
  onDelete,
}: Props) {
  const { aspect, thumb } = useVideoAspect(segment);
  const theme = useTheme();
  const mode = useThemeMode();
  // Player status — the ▶ badge shows only when playback is truly PARKED (readyToPlay and
  // not playing). Gating on !isPlaying alone flashed the badge through every clip switch:
  // selectSegment pauses for the swap, so the badge blinked for the load's duration.
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  // Not parked while a scrub drag is in flight: boundary crossings load clips, and the
  // status round-trips would blink the badge with every segment the finger crosses.
  const parked = !isPlaying && status === 'readyToPlay' && !scrubbing;
  // Render-phase reset + delayed set: the badge shows only once `parked` has HELD for the
  // delay (see PARK_BADGE_DELAY_MS), so transient parked windows mid-swap never flash it.
  const [showPlay, setShowPlay] = useState(parked);
  const [prevParked, setPrevParked] = useState(parked);
  if (prevParked !== parked) {
    setPrevParked(parked);
    if (!parked) setShowPlay(false);
  }
  useEffect(() => {
    if (!parked) return;
    const timer = setTimeout(() => setShowPlay(true), PARK_BADGE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [parked]);
  // Transient ⏸ flash — fired ONLY by this surface's own play tap. Thumb taps and auto
  // boundary advances must not flash it, so it's not derived from playingChange. Cleared by
  // the hold timer (its exiting zoom completes the ~1s arc) or instantly on pause, where the
  // ▶ badge takes over.
  const [pauseFlash, setPauseFlash] = useState(false);
  const [prevPlaying, setPrevPlaying] = useState(isPlaying);
  if (prevPlaying !== isPlaying) {
    setPrevPlaying(isPlaying);
    if (!isPlaying) setPauseFlash(false);
  }
  useEffect(() => {
    if (!pauseFlash) return;
    const timer = setTimeout(() => setPauseFlash(false), PAUSE_FLASH_HOLD_MS);
    return () => clearTimeout(timer);
  }, [pauseFlash]);
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
        onPress={() => {
          // Flash ⏸ only when this tap MEANS play; a pause tap hands over to the ▶ badge.
          setPauseFlash(!isPlaying);
          onTogglePlay();
        }}
        onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause' : 'Play'}>
        <View
          style={[styles.frame, { borderColor: FRAME_BORDER[mode] }, frameSize ?? styles.frameFill]}
          pointerEvents="none">
          {/* The VideoView is transparent until the player paints, so the clip's first-frame
              thumbnail sits permanently underneath — it shows through while the video loads
              (and across the fill→fitted remount below) and is covered the instant real
              frames exist. Same fit as the video, so the handoff is seamless. */}
          {thumb && (
            <ExpoImage
              source={thumb}
              style={StyleSheet.absoluteFill}
              contentFit={frameSize ? 'cover' : 'contain'}
            />
          )}
          {/* Thumbnail-derived ARs are pixel-rounded (≤192×256 jpegs), so a contain-fit can
              leak ~1% letterbox slivers inside the frame — they read as a fat border on the
              light backdrop. Cover crops that mismatch imperceptibly instead. The full-stage
              fallback keeps contain: there the frame AR is unrelated to the video's. Keyed
              so the fit flip REMOUNTS the view — mutating contentFit animates the native
              layer's gravity change (an unwanted zoom); the flip only happens once, inside
              the initial load window. */}
          <VideoView
            key={frameSize ? 'fitted' : 'fill'}
            style={StyleSheet.absoluteFill}
            player={player}
            contentFit={frameSize ? 'cover' : 'contain'}
            nativeControls={false}
          />
          {/* Scale-only animations on both badges: their GlassPills are UIVisualEffectViews,
              and ANY ancestor alpha < 1 (an opacity fade) renders the glass flat or not at
              all — transforms are the glass-safe way to animate them. */}
          {showPlay && (
            <Animated.View
              style={styles.playOverlay}
              pointerEvents="none"
              entering={ZoomIn.duration(150)}>
              <GlassPill style={styles.playBadge}>
                <Icon name="play.fill" size={28} tintColor="#fff" />
              </GlassPill>
            </Animated.View>
          )}
          {pauseFlash && (
            <Animated.View
              style={styles.playOverlay}
              pointerEvents="none"
              entering={ZoomIn.duration(150)}
              exiting={ZoomOut.duration(350)}>
              <GlassPill style={[styles.playBadge, styles.pauseBadge]}>
                <Icon name="pause.fill" size={28} tintColor="#fff" />
              </GlassPill>
            </Animated.View>
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
  // Measured box the frame centers in; margins keep the frame off screen edges and give it
  // breathing room from the top-bar ✕ and the action row.
  surface: {
    flex: 1,
    marginHorizontal: Spacing.two,
    marginVertical: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Square frame hugging the video rect (no rounding — the app doesn't round video surfaces)
  // so footage matching the backdrop stays legible; border color per mode (see FRAME_BORDER).
  frame: {
    borderWidth: 1,
  },
  // Until the aspect/layout is known, fill the stage (the video letterboxes inside) with no
  // border — the fallback rect is unrelated to the video, so outlining it flashes a giant
  // empty rectangle on open.
  frameFill: { alignSelf: 'stretch', flex: 1, borderWidth: 0 },
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
  // The ⏸ glyph is symmetric — undo the ▶ badge's optical nudge.
  pauseBadge: { paddingLeft: 0 },
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
