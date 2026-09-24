import { Icon } from '@/components/icon';
import { useEvent } from 'expo';
import { VideoView, type VideoPlayer } from 'expo-video';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { ZoomIn, ZoomOut } from 'react-native-reanimated';
import { probeVideo } from 'react-native-video-trim';

import { GlassPill } from '@/components/glass-pill';
import { ControlScrim, Spacing } from '@/constants/theme';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
import { absolutize } from '@/utils/file-store';
import { displaySize } from '@/utils/import-normalization';

import { hasGeometry, previewGeometry, type GeometryEdit, type Size } from './preview-geometry';

// Action badge diameter. With hitSlop 4 the effective tap target is 48pt (≥ the 44pt HIG
// minimum); the ✂ and 🗑 badges sit a full Spacing.five apart so their hit areas can't overlap.
const BADGE_SIZE = 40;
const BADGE_HIT_SLOP = 4;
// The "Revert Edits" pill is 28pt tall (the recorder timer pill's shape); 8pt slop keeps the tap
// target at 44pt.
const RESET_PILL_HEIGHT = 28;
const RESET_HIT_SLOP = 8;

// The ▶ badge appears only after playback has been parked this long. Clip switches and
// auto-advance pass through short "parked" windows the status can't distinguish (the old
// item's readyToPlay lingers a few frames until the next load flips it, and readyToPlay →
// playingChange has its own gap) — gating on held-time hides all of them.
const PARK_BADGE_DELAY_MS = 150;
// How long the transient ⏸ flash holds after playback starts before its fade-out begins.
const PAUSE_FLASH_HOLD_MS = 600;

// Display size of each source file, probed once. Originals are pinned to the portrait
// 1080×1920 contract (recorder pin, import/.pulse conform), the default until a probe lands.
const PORTRAIT: Size = { width: 1080, height: 1920 };
const sourceSizes = new Map<string, Size>();

function useSourceSize(file: string | null): Size {
  const [, setProbed] = useState(0);
  useEffect(() => {
    if (!file || sourceSizes.has(file)) return;
    let cancelled = false;
    probeVideo(absolutize(file))
      .then((probe) => {
        sourceSizes.set(file, displaySize(probe));
        if (!cancelled) setProbed((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [file]);
  return (file && sourceSizes.get(file)) || PORTRAIT;
}

type Props = {
  player: VideoPlayer;
  isPlaying: boolean;
  /** True while the bar playhead is being dragged — suppresses the play badge. */
  scrubbing?: boolean;
  onTogglePlay: () => void;
  onTrim: () => void;
  onDelete: () => void;
  /** Reset the active clip to its original — passed only when that clip has been edited. */
  onReset?: () => void;
  /** The active clip's geometry edit (rotate / flip / crop) and the file it applies to. */
  edit?: (GeometryEdit & { file: string }) | null;
};

/**
 * Full-bleed preview stage over the recorder — fills the area between the top bar and the
 * segment bar on a themed backdrop (the recorder covers the paused camera with the theme
 * background). Plays the draft through one shared player; tap toggles play, ✂ opens the RNVT
 * editor for the active clip, 🗑 deletes — centred in a row below the video — and ↺ (edited
 * clips only, "Revert Edits", pinned to that row's left edge) resets the clip to its original,
 * dropping every edit at once (trim, crop, rotate, flip, mute, speed). Closing and the
 * position / total readout live in the recorder's top bar, so nothing floats over the video.
 * The video renders full-bleed:
 * `contentFit="contain"` letterboxes into the themed backdrop and lets the native player
 * honor each clip's rotation matrix (portrait upright) — sizing off iOS `videoTrack.size`
 * is untrustworthy (un-rotated naturalSize). A clip with a geometry edit plays through view
 * transforms instead (preview-geometry: rotate, mirror, crop, fitted like the export's canvas),
 * as RNVT's editor previews it. No captions here — transcription now happens once on the
 * merged video at export time.
 */
export function PreviewModal({
  player,
  isPlaying,
  scrubbing = false,
  onTogglePlay,
  onTrim,
  onDelete,
  onReset,
  edit,
}: Props) {
  const theme = useTheme();
  const mode = useThemeMode();
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const geometric = edit && hasGeometry(edit) ? edit : null;
  const source = useSourceSize(geometric?.file ?? null);
  const geometry = geometric ? previewGeometry(stage, source, geometric) : null;
  // Player status — the ▶ badge shows only when playback is truly PARKED (readyToPlay and
  // not playing). Gating on !isPlaying alone flashed the badge through every clip switch:
  // selectSegment pauses for the swap, so the badge blinked for the load's duration.
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  // Not parked while a scrub drag is in flight: boundary crossings load clips, and the
  // status round-trips would blink the badge with every segment the finger crosses. Also
  // not before the session's FIRST playback: a thumb tap auto-plays, but a cold load can
  // sit readyToPlay-but-not-playing longer than the held-park delay — the badge flashed
  // right before the video started. Until something has actually played, stay quiet.
  const [everPlayed, setEverPlayed] = useState(isPlaying);
  const parked = everPlayed && !isPlaying && status === 'readyToPlay' && !scrubbing;
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
    if (isPlaying) setEverPlayed(true);
    else setPauseFlash(false);
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
        <View
          style={styles.fill}
          pointerEvents="none"
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            setStage({ width, height });
          }}>
          {/* One stable wrapper, so toggling an edit never remounts the video view: the whole
              stage when unedited, else the cropped box (clips the transformed picture). */}
          <View style={geometry ? [styles.cropBox, geometry.box] : StyleSheet.absoluteFill}>
            <VideoView
              style={
                geometry
                  ? {
                      position: 'absolute',
                      left: geometry.video.left,
                      top: geometry.video.top,
                      width: geometry.video.width,
                      height: geometry.video.height,
                      transform: geometry.video.transform,
                    }
                  : StyleSheet.absoluteFill
              }
              player={player}
              contentFit="contain"
              nativeControls={false}
              // Android: a SurfaceView ignores view transforms and clipping.
              surfaceType="textureView"
            />
          </View>
          {/* ONE badge for ▶ and ⏸ — the glyph swaps in place so a play tap doesn't unmount
              one glass pill and zoom in a fresh one. ⏸ wins while both states overlap (the
              tap→playingChange gap). Scale-only animation: the GlassPill is a
              UIVisualEffectView, and ANY ancestor alpha < 1 renders the glass flat or not at
              all. The ⏸ exit is slower — it's the tail of the flash's ~1s arc. */}
          {(showPlay || pauseFlash) && (
            <Animated.View
              style={styles.playOverlay}
              pointerEvents="none"
              entering={ZoomIn.duration(150)}
              exiting={ZoomOut.duration(pauseFlash ? 350 : 150)}>
              <GlassPill style={[styles.playBadge, pauseFlash && styles.pauseBadge]}>
                <Icon name={pauseFlash ? 'pause.fill' : 'play.fill'} size={28} tintColor="#fff" />
              </GlassPill>
            </Animated.View>
          )}
        </View>
      </Pressable>

      <View style={styles.actionRow}>
        {/* "Revert Edits" pinned to the row's far left, apart from ✂/🗑 — a different kind of
            action (discard a clip's saved edits), and pinning it out of the flow keeps ✂/🗑
            centred either way. */}
        {onReset && (
          <View style={styles.resetSlot} pointerEvents="box-none">
            <Pressable
              onPress={onReset}
              hitSlop={RESET_HIT_SLOP}
              accessibilityRole="button"
              accessibilityLabel="Revert Edits">
              <View style={[styles.resetPill, ControlScrim[mode]]}>
                <Text style={styles.resetText}>Revert Edits</Text>
              </View>
            </Pressable>
          </View>
        )}
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
  cropBox: { position: 'absolute', overflow: 'hidden' },
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
  // Same row, same vertical centre as ✂/🗑; inset like the top bar's ✕ (recorder.tsx topBar).
  resetSlot: {
    position: 'absolute',
    left: Spacing.three,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  // Small text-only pill, so it reads as its own action rather than a third icon badge.
  resetPill: {
    height: RESET_PILL_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
    borderRadius: RESET_PILL_HEIGHT / 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
  resetText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
