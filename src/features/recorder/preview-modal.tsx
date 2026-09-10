import { Icon } from '@/components/icon';
import { useEvent } from 'expo';
import { VideoView, type VideoPlayer } from 'expo-video';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { ZoomIn, ZoomOut } from 'react-native-reanimated';

import { GlassPill } from '@/components/glass-pill';
import { ControlScrim, Spacing } from '@/constants/theme';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
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

type Props = {
  player: VideoPlayer;
  isPlaying: boolean;
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
 * Full-bleed preview stage over the recorder — fills the area between the top bar and the
 * segment bar on a themed backdrop (the recorder covers the paused camera with the theme
 * background). Plays the draft through one shared player; tap toggles play, ✂ opens the RNVT
 * editor for the active clip, 🗑 deletes — both in a row below the video. Closing lives in the
 * recorder's top bar, so there's exactly one ✕ on screen. The video renders full-bleed:
 * `contentFit="contain"` letterboxes into the themed backdrop and lets the native player
 * honor each clip's rotation matrix (portrait upright) — sizing off iOS `videoTrack.size`
 * is untrustworthy (un-rotated naturalSize). No captions here — transcription now happens
 * once on the merged video at export time.
 */
export function PreviewModal({
  player,
  isPlaying,
  scrubbing = false,
  positionMs,
  totalMs,
  onTogglePlay,
  onTrim,
  onDelete,
}: Props) {
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

  return (
    <View style={[styles.stage, { backgroundColor: theme.background }]}>
      <Pressable
        style={styles.surface}
        onPress={() => {
          // Flash ⏸ only when this tap MEANS play; a pause tap hands over to the ▶ badge.
          setPauseFlash(!isPlaying);
          onTogglePlay();
        }}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? 'Pause' : 'Play'}>
        <View style={styles.fill} pointerEvents="none">
          <VideoView
            style={StyleSheet.absoluteFill}
            player={player}
            contentFit="contain"
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
            {/* Mode-aware scrim like the action badges — contain-fit letterboxing can put the
                pill on the flat backdrop, where glass has nothing to refract. */}
            <View style={[styles.timePill, ControlScrim[mode]]}>
              <Text style={styles.timeText}>
                {formatDurationPadded(positionMs)} / {formatDurationPadded(totalMs)}
              </Text>
            </View>
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
  // Full-bleed video area; margins keep it off screen edges and give it breathing room from
  // the top-bar ✕ and the action row.
  surface: {
    flex: 1,
    marginHorizontal: Spacing.two,
    marginVertical: Spacing.two,
  },
  fill: { flex: 1 },
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
  // Scrim-backed shape, matching the action badges below; hairline edge shows in dark mode
  // (ControlScrim.light keeps it transparent).
  timePill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  timeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.3,
  },
});
