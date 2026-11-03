import { type Href, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedReaction, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Camera,
  type CameraDevice,
  type Constraint,
  useCameraDevices,
} from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';

import { ThemedView } from '@/components/themed-view';
import { GlassPill } from '@/components/glass-pill';
import { useTextSizeKey } from '@/hooks/use-text-size-key';
import { Spacing } from '@/constants/theme';
import { flushDraftWrites } from '@/features/editor/draft-writes';
import { CameraControls } from '@/features/recorder/camera-controls';
import { ExportButton } from '@/components/export-button';
import { CloseButton } from '@/features/recorder/close-button';
import { EditButton } from '@/features/recorder/edit-button';
import { ImportButton } from '@/features/recorder/import-button';
import {
  DEFAULT_LENS_LABEL,
  type LensPreset,
  LensSelector,
} from '@/features/recorder/lens-selector';
import { PermissionGate } from '@/features/recorder/permission-gate';
import { CONTROLS_FADE, RecordButton } from '@/features/recorder/record-button';
import { SegmentBar } from '@/features/recorder/segment-bar';
import { RECORD_BUTTON_SIZE } from '@/features/recorder/track-metrics';
import { useAudioFocus } from '@/features/recorder/use-audio-focus';
import { useRecorder } from '@/features/recorder/use-recorder';
import { RETICLE_SIZE, useFocusReticle } from '@/features/recorder/use-focus-reticle';
import { useRecorderGestures } from '@/features/recorder/use-recorder-gestures';
import { useRecorderPermissions } from '@/features/recorder/use-recorder-permissions';
import { RecordingTimer } from '@/features/recorder/recording-timer';
import { setClipQueuePaused } from '@/features/transcription/clip-queue';
import { useClipTranscription } from '@/features/transcription/use-clip-transcription';
import { TipAnchor } from '@/features/tips/tip-anchor';
import { TipLayer } from '@/features/tips/tip-callout';
import { useTip } from '@/features/tips/use-tip';
import { muteHaptics } from '@/utils/haptics';
import { closeToHome } from '@/utils/navigation';

/**
 * Lens chips from each lens's focal length, for Android, where CameraX names every lens
 * "unknown": a lens's stop is its 35 mm-equivalent focal length over the main lens's (the
 * camera's own), e.g. a Galaxy S24 Ultra's 13.6 / 22.3 / 61 / 112.7 mm → 0.6x · 1x · 3x · 5x.
 * Android reports raw millimetres, which don't compare across sensors, so this relies on
 * patches/react-native-vision-camera (35 mm-equivalent). A chip zooms to its rounded stop, where
 * phones switch to that lens; the widest to `minZoom`. Null when the phone reports fewer than two
 * lenses with focal lengths or no main lens: the zoom-range fallback below takes over.
 */
function focalLengthPresets(device: CameraDevice): LensPreset[] | null {
  const main = device.focalLength;
  const focals = device.physicalDevices
    .map((d) => d.focalLength)
    .filter((f): f is number => f != null && f > 0)
    .sort((a, b) => a - b);
  if (main == null || main <= 0 || focals.length < 2) return null;
  const presets: LensPreset[] = [];
  for (const focal of focals) {
    const ratio = focal / main;
    if (ratio < 0.95) {
      // Reachable only if the zoom range goes that wide.
      if (device.minZoom > ratio + 0.1) continue;
      presets.push({ label: `${device.minZoom.toFixed(1)}x`, zoom: device.minZoom });
    } else if (ratio <= 1.05) {
      presets.push({ label: DEFAULT_LENS_LABEL, zoom: 1 });
    } else {
      const stop = Math.round(ratio);
      if (stop > device.maxZoom) continue;
      presets.push({ label: `${stop}x`, zoom: stop });
    }
  }
  const unique = presets.filter((p, i) => presets.findIndex((q) => q.label === p.label) === i);
  return unique.length >= 2 && unique.some((p) => p.label === DEFAULT_LENS_LABEL) ? unique : null;
}

/**
 * The camera for a side: the one with the most lenses (so 0.5x / 1x / Tele are all reachable by
 * zoom), then the widest zoom range. Not VisionCamera's own pick: it scores each lens against the
 * types asked for and takes a point off for any other type, and CameraX reports every lens as
 * "unknown". A Galaxy S24 Ultra lists its 4-lens back camera (0.6–10×) and its ultra-wide alone
 * (1–8×), and the ultra-wide won (-4 vs 0): every recording on the ultra-wide, with no lens chips.
 */
function pickCamera(devices: CameraDevice[], position: 'front' | 'back'): CameraDevice | undefined {
  return devices
    .filter((d) => d.position === position)
    .reduce<CameraDevice | undefined>((best, d) => {
      if (!best) return d;
      if (d.physicalDevices.length !== best.physicalDevices.length) {
        return d.physicalDevices.length > best.physicalDevices.length ? d : best;
      }
      if (d.minZoom !== best.minZoom) return d.minZoom < best.minZoom ? d : best;
      return d.maxZoom > best.maxZoom ? d : best;
    }, undefined);
}

// Upper zoom cap (factor). Devices expose 100x+ of mostly-unusable digital zoom; cap so the
// drag/pinch range stays useful. Tunable on-device.
const MAX_ZOOM_FACTOR = 16;
// A second -11800 landing this soon after a recovery bounce means the rebuilt session hit the
// same wall (an undetected call still owns the mic) — stop bouncing and drop the mic instead.
const SESSION_ERROR_ESCALATION_MS = 3000;
// One beat for a video player's post-unload audio-session writes (async, on its own queue) to
// flush before the recording config is restored — restoring first would let a late `.playback`
// write clobber it right back.
const AUDIO_HANDOFF_SETTLE_MS = 50;

export default function RecorderScreen() {
  const insets = useSafeAreaInsets();
  // Re-measures the timer text when the system text size changes (see `useTextSizeKey`).
  const textSizeKey = useTextSizeKey();
  const { draftId: draftIdParam } = useLocalSearchParams<{ draftId?: string }>();
  const permissions = useRecorderPermissions();
  const {
    cameraRef,
    videoOutput,
    draftId,
    segments,
    isRecording,
    recordStartedAt,
    recordStoppedAt,
    startQueued,
    recordingShownNow,
    cameraReady,
    prefsReady,
    facing,
    torch,
    stabilization,
    muted,
    callActive,
    appActive,
    reportMicPriorityError,
    onCameraReady,
    onSessionConfigured,
    toggleRecording,
    finalizeRecording,
    importClip,
    isImporting,
    importProgress,
    startHoldRecording,
    endHoldRecording,
    flipCamera,
    toggleTorch,
    toggleMute,
    cycleStabilization,
    deleteSegment,
    reorderSegments,
  } = useRecorder(draftIdParam);

  // True while a clip is being dragged (reorder / drag-to-trash) — hides the record button so
  // the floating trash above the bar has clear space.
  const [dragging, setDragging] = useState(false);

  // While the editor or Export is presented over this one, the recorder is unfocused — drop the
  // camera session so it isn't capturing (and burning power) behind the modal. Restored on return.
  const [focused, setFocused] = useState(true);
  // One screen opened per tap: router.push always adds a screen, and two taps before it's shown
  // would stack two editors over the same draft. Open again once back on this screen. Edits an
  // editor just closed is still storing land first (export reads the stored clips).
  const opening = useRef(false);
  useFocusEffect(
    useCallback(() => {
      opening.current = false;
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const open = (href: Href) => {
    if (opening.current) return;
    opening.current = true;
    void flushDraftWrites().then(() => router.push(href));
  };

  // The clip bar's clips, held while another screen (the editor) covers the recorder: sortables
  // lays its grid out from measurements, and a reorder applied while the recorder's views were off
  // screen left a thumbnail hidden or clips stuck lifted with the trash up. Back on screen, clips
  // changed meanwhile rebuild the bar (a new key) rather than animate into place.
  const [bar, setBar] = useState({ segments, key: 0, stale: false });
  if (bar.segments !== segments) {
    if (focused) {
      setBar({ segments, key: bar.stale ? bar.key + 1 : bar.key, stale: false });
      // A drag the old bar never ended can't keep the record button hidden.
      if (bar.stale) setDragging(false);
    } else if (!bar.stale) setBar({ ...bar, stale: true });
  }

  // Captions: each clip is transcribed in the background between takes (never while recording:
  // the model would compete with the capture, so the queue pauses and resumes after the take).
  useClipTranscription(segments, focused && !isRecording);
  useEffect(() => {
    setClipQueuePaused(isRecording);
  }, [isRecording]);
  useEffect(() => () => setClipQueuePaused(false), []);

  // Audio focus: while the recorder is on screen capturing with a live mic, pause other apps'
  // audio (Spotify / podcasts) rather than mixing it in; restore on leave or mute. Gated on the
  // mic being live — a muted clip has no audio track, so there's nothing to seize focus for.
  // Also released while a call is active: we must yield the audio session to telephony, not fight
  // it for focus. Tied to screen focus (not per segment) to avoid toggling the session mid-draft.
  // Destructured because useAudioFocus() returns a fresh object each render — depending on
  // the stable acquire/release callbacks (not the object) keeps the effect from re-running
  // (and re-applying the session config) on every render.
  const { acquire: acquireFocus, release: releaseFocus } = useAudioFocus();
  useEffect(() => {
    const shouldHold = focused && appActive && !muted && !callActive && prefsReady;
    if (shouldHold) void acquireFocus();
    else void releaseFocus();
  }, [focused, appActive, muted, callActive, prefsReady, acquireFocus, releaseFocus]);
  useEffect(() => () => void releaseFocus(), [releaseFocus]);

  // Audio handoff: back from a screen that played video (the editor sets a playback session),
  // the shared audio session returns to the recorder, and the camera restart re-attaches the mic
  // input (enableAudio keeps it on the main capture session). If the restart wins the race
  // against the session-config restore — the player's post-unload writes and the acquire above
  // are both async — the mic I/O unit starts under a playback-only category and AVFoundation
  // kills the session with -11800 (underlying -10868, kAudioUnitErr_FormatNotSupported).
  // Sequence instead of race: hold the camera off (cameraActive below) for one settle beat + an
  // acquire, then restart. Detected as a render-phase transition so the same commit that
  // regains focus already holds the camera off. Muted / in-call returns skip the hold — they
  // restart video-only, and a category can't break a session with no mic input.
  const [audioHandoff, setAudioHandoff] = useState(false);
  const [wasFocused, setWasFocused] = useState(focused);
  if (wasFocused !== focused) {
    setWasFocused(focused);
    if (focused && !muted && !callActive) setAudioHandoff(true);
  }
  useEffect(() => {
    if (!audioHandoff) return;
    let stale = false;
    const timer = setTimeout(() => {
      // acquire never throws (documented in use-audio-focus) — .then always runs.
      void acquireFocus().then(() => {
        if (!stale) setAudioHandoff(false);
      });
    }, AUDIO_HANDOFF_SETTLE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [audioHandoff, acquireFocus]);

  // An AVFoundation -11800 leaves the capture session FROZEN (it doesn't self-recover), so we
  // react to the error directly and bounce the session off→on for a tick to force a clean restart
  // out of the failed state (`recovering` drives the bounce). The -11800 family has two flavors
  // needing different handling:
  //  - '!pri' (561017449): telephony owns the mic — a call the interruption latch couldn't see
  //    (already in progress at cold open / resume, so none of our audio was active to be
  //    interrupted; the snapshot read "no call" and the mic attached anyway).
  //    Drop the mic until the next authoritative call event (reportMicPriorityError rebuilds the
  //    output video-only); recording with it would just re-throw.
  //  - plain -11800 (e.g. underlying -10868, kAudioUnitErr_FormatNotSupported): the session
  //    (re)started while the shared AVAudioSession sat in a playback-only category — the
  //    audio handoff race (see the handoff above). Transient: re-assert the
  //    recording config and bounce; latching the mic here is issue #124's false "On call" state,
  //    which silently records every later clip without audio. If the bounce lands on the same
  //    wall (a second -11800 inside the escalation window — an undetected call), stop bouncing
  //    and drop the mic after all, so an error can never flicker-loop the camera.
  const [recovering, setRecovering] = useState(false);
  const recoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSessionErrorRef = useRef(0);
  useEffect(() => () => clearTimeout(recoverTimerRef.current ?? undefined), []);
  const onCameraError = useCallback(
    (e: unknown) => {
      const hay = `${String((e as { message?: unknown })?.message ?? '')} ${String(e)}`;
      // CameraX cancels control calls (zoom/torch) that land during session transitions with
      // OperationCanceledException — benign on Android (the next applied value wins), so don't
      // treat it as a real camera error.
      if (
        hay.includes('OperationCanceledException') ||
        hay.includes('Camera is not active') ||
        hay.includes('new enableTorch being set')
      )
        return;
      // VisionCamera wraps the native error; the AVFoundation domain/code and '!pri' four-char code
      // survive in the stringified message, so match on those rather than a brittle wrapper code.
      const micPriority = hay.includes('!pri') || hay.includes('561017449');
      if (!micPriority && !hay.includes('-11800')) {
        console.error('[Camera]', e);
        return;
      }
      // Recovered below — log without the dev red-box a console.error would raise.
      console.warn('[Camera] capture session error, recovering:', e);
      const now = Date.now();
      const repeated = now - lastSessionErrorRef.current < SESSION_ERROR_ESCALATION_MS;
      lastSessionErrorRef.current = now;
      if (micPriority || repeated) {
        reportMicPriorityError();
      } else if (!muted && !callActive) {
        // Restore `.playAndRecord` before the bounce restarts the session, so the retry can't
        // trip over the same stale playback-only category that killed it.
        void acquireFocus();
      }
      // Clustered errors must not let an earlier timer flip `recovering` off mid-bounce — restart it.
      clearTimeout(recoverTimerRef.current ?? undefined);
      setRecovering(true);
      recoverTimerRef.current = setTimeout(() => {
        recoverTimerRef.current = null;
        setRecovering(false);
      }, 150);
    },
    [reportMicPriorityError, muted, callActive, acquireFocus],
  );

  const devices = useCameraDevices();
  const device = useMemo(() => pickCamera(devices, facing), [devices, facing]);

  // Lens chips are zoom presets on the (possibly multi-camera) device. Each physical lens
  // engages at a zoom boundary: the widest lens at `minZoom`, every subsequent lens at the
  // device's ascending `zoomLensSwitchFactors`. Assigning those boundaries to the present
  // lenses widest→narrowest is the device-agnostic mapping (e.g. a phone whose widest lens is
  // the ultra-wide has 0.5x at minZoom and 1x at the first switch factor — NOT at a literal 1).
  // Only surfaced when the lens exists, so a single-lens front camera shows no chips.
  const { lensPresets, neutralZoom } = useMemo(() => {
    if (!device) return { lensPresets: [] as LensPreset[], neutralZoom: 1 };
    const types = new Set(device.physicalDevices.map((d) => d.type));
    const order = [
      { type: 'ultra-wide-angle', label: '0.5x' },
      { type: 'wide-angle', label: DEFAULT_LENS_LABEL },
      { type: 'telephoto', label: 'Tele' },
    ] as const;
    const present = order.filter((o) => types.has(o.type));
    if (present.length === 0) {
      const byFocal = focalLengthPresets(device);
      if (byFocal) return { lensPresets: byFocal, neutralZoom: 1 };
      // Android: CameraX regularly reports no per-lens metadata even on multi-camera phones
      // (physicalDevices comes back empty), so derive presets from the logical zoom bounds
      // instead: a sub-1 minZoom means an ultra-wide is fused into the logical camera, and any
      // switch factor above 1 marks where a telephoto engages. Single-lens devices
      // (minZoom=1, no factors) produce <2 presets and correctly show no chips.
      const derived: LensPreset[] = [];
      if (device.minZoom < 0.95) derived.push({ label: '0.5x', zoom: device.minZoom });
      derived.push({ label: DEFAULT_LENS_LABEL, zoom: 1 });
      const tele = device.zoomLensSwitchFactors.find((f) => f > 1);
      if (tele != null) derived.push({ label: 'Tele', zoom: tele });
      if (derived.length < 2) return { lensPresets: [], neutralZoom: Math.max(1, device.minZoom) };
      return { lensPresets: derived, neutralZoom: 1 };
    }
    const boundaries = [device.minZoom, ...device.zoomLensSwitchFactors];
    const presets: LensPreset[] = present.map((o, i) => ({
      label: o.label,
      zoom: boundaries[i] ?? device.minZoom,
    }));
    // The camera opens at (and flips back to) the 1x wide lens when present, else the widest.
    const neutral = presets.find((p) => p.label === DEFAULT_LENS_LABEL)?.zoom ?? device.minZoom;
    // With the wide lens there, the other chips say their stop relative to it, as the Camera app
    // does: 0.5x, and the telephoto's 2x / 2.5x / 3x / 4x / 5x by model instead of "Tele" (to a
    // tenth, so an iPhone 12 Pro Max's 2.5x telephoto doesn't read 3x).
    const wide = presets.some((p) => p.label === DEFAULT_LENS_LABEL) ? neutral : null;
    const labelled = presets.map((p) => {
      if (wide == null || p.label === DEFAULT_LENS_LABEL) return p;
      const stop = Math.round((p.zoom / wide) * 10) / 10;
      return { ...p, label: `${Number.isInteger(stop) ? stop : stop.toFixed(1)}x` };
    });
    return { lensPresets: labelled, neutralZoom: neutral };
  }, [device]);

  // Pinned 1080p output + 30fps so every recorded clip is format-uniform (fast-path merge).
  // Stabilization is the back camera's: the front records without it, as its control is hidden
  // there (the setting is kept for the back).
  const constraints = useMemo<Constraint[]>(
    () => [{ videoStabilizationMode: facing === 'front' ? 'off' : stabilization }, { fps: 30 }],
    [facing, stabilization],
  );
  const outputs = useMemo(() => [videoOutput], [videoOutput]);

  // Tap-to-focus: meters 3A (AF/AE/AWB) to the tapped point and shows a reticle there. Honors
  // VisionCamera's focus guidance (supportsFocusMetering guard; steady while filming, snappy
  // while framing). Focus auto-returns to continuous AF after a few seconds.
  const { onFocus, reticleStyle } = useFocusReticle({
    cameraRef,
    supportsFocus: device?.supportsFocusMetering ?? false,
    isRecording,
  });

  // Re-assert the recording session config right before a take starts — cheap insurance
  // against anything else (another expo-video player, a system event) having flipped the
  // session category since the last acquire. No-op when the config is already correct.
  // Awaited so the session is `.playAndRecord` BEFORE the recorder attaches the mic input. Only
  // a start waits for it: on Android it takes 20–90 ms, which a stop tap would feel.
  // What the record button shows, on the UI thread: the gestures flip it as the finger decides,
  // so the button answers in that frame however busy JS is; after each request the recorder
  // writes back what it actually did (a start it refused, a hold dropped below), and the button
  // follows the take's own state too (see RecordButton).
  const recordingShown = useSharedValue(false);

  const onToggle = useCallback(async () => {
    // Only a tap that starts (or queues) a take waits: one that stops a take or takes back a
    // queued one must act at once, or the queued take could start during the wait and this tap
    // then stop it, leaving a short clip.
    if (!recordingShownNow() && !muted && !callActive) await acquireFocus();
    toggleRecording();
    recordingShown.set(recordingShownNow());
  }, [toggleRecording, recordingShownNow, recordingShown, muted, callActive, acquireFocus]);

  // Hold-to-record needs more than onToggle: acquire() is awaited, and the gesture's
  // release reaches JS straight away via scheduleOnRN — a quick press-release could run onHoldEnd
  // BEFORE the delayed startHoldRecording() (holdInitiatedRef still false, so nothing to
  // stop), and the start would then fire AFTER the gesture ended, leaving an unheld
  // in-progress recording. Every hold edge bumps a sequence number; the delayed start is
  // dropped when its hold is no longer the live one.
  const holdSeqRef = useRef(0);
  const onHoldStart = useCallback(async () => {
    const seq = ++holdSeqRef.current;
    if (!muted && !callActive) await acquireFocus();
    if (seq === holdSeqRef.current) startHoldRecording();
    recordingShown.set(recordingShownNow());
  }, [muted, callActive, acquireFocus, startHoldRecording, recordingShownNow, recordingShown]);
  const onHoldEnd = useCallback(() => {
    holdSeqRef.current++;
    endHoldRecording();
    recordingShown.set(recordingShownNow());
  }, [endHoldRecording, recordingShownNow, recordingShown]);

  const {
    zoomSv,
    chipTarget,
    holdActive,
    pressed,
    buttonGesture,
    screenGesture,
    resetZoom,
    setZoomTo,
  } = useRecorderGestures({
    onToggle,
    recordingShown,
    onHoldStart,
    onHoldEnd,
    onFocus,
    enabled: cameraReady && !dragging,
    neutralZoom,
    minZoom: device?.minZoom ?? 1,
    maxZoom: device ? Math.min(device.maxZoom, MAX_ZOOM_FACTOR) : 1,
  });

  // The camera allows haptics (see <Camera>), so mute them while a clip records: the mic would
  // pick one up. Start's haptic fires before capture begins, so it still lands.
  useEffect(() => {
    muteHaptics(isRecording);
    return () => muteHaptics(false);
  }, [isRecording]);

  // Zoom factors aren't portable across a flip, so reset to neutral 1x. (A lens chip sets its
  // own factor; flipping mid-recording already stops the recording natively.)
  useEffect(() => {
    resetZoom();
  }, [facing, resetZoom]);

  // The highlighted lens chip tracks the LIVE zoom (pinch / drag / chip-tap all move zoomSv),
  // so it reflects whichever physical lens the current factor sits on — the highest preset whose
  // boundary the zoom has reached. While a chip's ramp runs it shows that chip's target instead,
  // so the highlight lands with the tap and its haptic, not 220 ms later, and never passes
  // through 1x on the way from 0.5x to Tele. JS is called only when the active lens changes.
  const [activeLens, setActiveLens] = useState(DEFAULT_LENS_LABEL);
  useAnimatedReaction(
    () => {
      const target = chipTarget.get();
      const zoom = target >= 0 ? target : zoomSv.get();
      let label = lensPresets[0]?.label;
      for (const p of lensPresets) {
        if (zoom >= p.zoom) label = p.label;
      }
      return label;
    },
    (label, prev) => {
      if (label != null && label !== prev) scheduleOnRN(setActiveLens, label);
    },
    [lensPresets],
  );

  // First-run tips, one at a time: the shutter before the first clip, then the clips once one
  // has landed. They never get in the way of recording: one only appears once the shutter has
  // been left alone for a moment (not touched, held or recording; 2 s after a take, so it can't pop
  // up between takes), and the first touch anywhere on the recorder closes it — that touch carries
  // on as usual, so a tap still records and a hold still records and zooms. Each tip is then done
  // for good (see `useTip`).
  const [shutterTouched, setShutterTouched] = useState(false);
  useAnimatedReaction(
    () => pressed.get() || holdActive.get(),
    (touched, prev) => {
      if (touched !== prev) scheduleOnRN(setShutterTouched, touched);
    },
  );
  const shutterIdle = focused && appActive && cameraReady && !isRecording && !shutterTouched;
  const recordTip = useTip('record', shutterIdle && segments.length === 0, {
    delayMs: 1000,
    learned: isRecording,
  });
  const clipsTip = useTip('clips', shutterIdle && !dragging && segments.length > 0, {
    delayMs: 2000,
    learned: dragging,
  });
  // After the clips tip (one tip at a time): the button that opens the whole draft in the editor.
  const editTip = useTip(
    'edit',
    shutterIdle && !dragging && segments.length > 0 && !clipsTip.mounted,
    { delayMs: 2000 },
  );
  const closeTips = () => {
    recordTip.dismiss();
    clipsTip.dismiss();
    editTip.dismiss();
    return false; // never takes the touch: it goes on to the shutter, the camera or the control
  };

  if (!permissions.ready) return <ThemedView style={styles.fill} />;
  if (!permissions.granted) {
    return <PermissionGate blocked={permissions.blocked} onRequest={permissions.request} />;
  }
  // Hold the camera until persisted prefs load, so the first frame uses the saved facing.
  if (!prefsReady) return <ThemedView style={styles.fill} />;

  // The camera is live only when recording is possible: not while the editor or Export covers
  // this screen, and not while backgrounded — VisionCamera's `isActive` pauses the session in
  // place on both platforms. Background is included (not just blur) because iOS would
  // otherwise auto-resume the session on foreground with the mic still attached, straight into a
  // call that started in the background (the -11800 freeze below); waiting for `appActive` lets
  // call detection re-poll first. `|| isRecording` keeps the session up while a clip finalizes in
  // background, so the segment saves before we tear it down. `!recovering` drops it for one bounce
  // after a mic-priority error so it rebuilds cleanly, and `!audioHandoff` holds the restart after
  // the editor closes until the recording session config is back (see the handoff above).
  const cameraActive = !audioHandoff && focused && (appActive || isRecording) && !recovering;

  // Close: finalize any in-flight clip (saving it into the draft) before navigating home, so the
  // segment isn't lost when the camera unmounts.
  const handleClose = () => void finalizeRecording().then(closeToHome);

  return (
    <View style={styles.fill} onStartShouldSetResponderCapture={closeTips}>
      {/* Light over the live camera whatever the theme. Only while this screen is focused: the
          last StatusBar mounted wins, and the recorder stays mounted under the editor and Export,
          which should get the root's again. */}
      {focused && <StatusBar style="light" />}
      {device && (
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={cameraActive}
          outputs={outputs}
          // Reels contract: recordings are ALWAYS portrait. VisionCamera's default source is
          // 'device' — physically holding the phone sideways rotates the output orientation even
          // though the UI is portrait-locked, writing a landscape-tagged clip. 'interface'
          // follows the (locked) UI orientation, so sideways recordings stay portrait: the
          // sensor frame is unchanged, only the rotation tag stops following the gyro.
          orientationSource="interface"
          // iOS mutes every haptic while a capture session runs unless this is on, which left the
          // recorder's haptics (record start, hold, lens, clips and the trash) silent. None fire
          // while a clip records, though (the mic would pick them up): see `muteHaptics` below.
          allowHapticsAndSystemSoundsPlayback
          // Zoom/torch are gated until the session has started — but only on Android: CameraX
          // rejects control calls on an inactive camera (OperationCanceledException), so applying
          // these props on mount — before `onStarted` — throws unhandled rejections there.
          // `undefined` makes VisionCamera's updater hooks skip the native call; the shared-value
          // binding still applies the current zoom the moment it attaches. iOS quietly tolerates
          // early calls and NEEDS the immediate binding: without it the session opens on the
          // native default lens (ultra-wide on fused multi-cam iPhones — dark preview) and then
          // visibly snaps to 1x when the gate opens at `onStarted`.
          zoom={Platform.OS === 'ios' || cameraReady ? zoomSv : undefined}
          // ...and torch is additionally gated on hardware: writing any torchMode (even 'off') to
          // a torch-less camera (typically the front one) throws IllegalStateException("No flash
          // unit") on Android, while iOS silently ignores it.
          torchMode={
            (Platform.OS === 'ios' || cameraReady) && device.hasTorch
              ? torch
                ? 'on'
                : 'off'
              : undefined
          }
          constraints={constraints}
          // Smooth (rather than snapping) continuous-AF transitions — VisionCamera's recommended
          // setting for video, so refocus pulls look cinematic instead of "hunting". Gated on
          // device support so it never throws; tap-to-focus stays snappy via `responsiveness`.
          enableSmoothAutoFocus={device?.supportsSmoothAutoFocus ?? false}
          onConfigured={onSessionConfigured}
          onStarted={() => {
            onCameraReady();
            // The capture session reconfigures the app's audio session as it starts, after the
            // focus effect's acquire, which drops the "allow haptics" setting (iOS honours it only
            // on activation): the recorder was silent until the first recording re-acquired.
            // Re-acquiring here, the same call every record tap makes, applies it from the start.
            if (!muted && !callActive) void acquireFocus();
          }}
          onError={onCameraError}
        />
      )}

      {/* Tap-to-focus + pinch-to-zoom surface. Camera can't take children, so this sits between
          it and the overlay; the overlay is box-none, so touches that miss a control land here.
          Single-finger tap focuses to that point; two-finger pinch zooms. */}
      <GestureDetector gesture={screenGesture}>
        <View style={StyleSheet.absoluteFill} />
      </GestureDetector>

      {/* Focus reticle — driven imperatively by onFocus; pointer-transparent. */}
      <Animated.View pointerEvents="none" style={[styles.reticle, reticleStyle]} />

      <View style={[StyleSheet.absoluteFill, styles.overlay]} pointerEvents="box-none">
        <View
          style={[
            styles.topBar,
            { paddingTop: insets.top + Spacing.two, paddingHorizontal: Spacing.three },
          ]}>
          <View style={styles.topBarSide}>
            <CloseButton onPress={handleClose} overVideo label="Close recorder" />
          </View>
          {/* The running total, on glass over the live camera. */}
          <GlassPill style={styles.timerPill}>
            <RecordingTimer
              key={textSizeKey}
              style={styles.timerText}
              segments={segments}
              startedAt={recordStartedAt}
              stoppedAt={recordStoppedAt}
            />
          </GlassPill>
          {/* On to the export screen once there's a clip; the sides share the width equally so
              the timer stays centred either way. */}
          <View style={[styles.topBarSide, styles.topBarEnd]}>
            {draftId && segments.length > 0 && (
              <ExportButton
                onPress={() => open({ pathname: '/export', params: { draftId } })}
                disabled={isRecording}
              />
            )}
          </View>
        </View>

        <CameraControls
          facing={facing}
          torch={torch}
          stabilization={stabilization}
          muted={muted}
          callActive={callActive}
          recording={isRecording}
          onFlip={flipCamera}
          onToggleTorch={toggleTorch}
          onCycleStabilization={cycleStabilization}
          onToggleMute={toggleMute}
        />

        <View
          style={[styles.bottom, { paddingBottom: insets.bottom + Spacing.three }]}
          pointerEvents="box-none">
          {/* During a drag the record controls go (opacity 0, layout kept) so the floating trash
              above the bar has clear space and nothing shifts. The lens pill steps out and back
              rather than fading with the others: it's glass, and a partly transparent ancestor
              makes iOS draw glass flat, sometimes for good. */}
          <View style={{ transform: [{ scale: dragging ? 0 : 1 }] }}>
            <LensSelector
              presets={lensPresets}
              selected={activeLens}
              onSelect={(preset) => setZoomTo(preset.zoom)}
              // Live while recording, like drag and pinch zoom: a chip only moves the zoom.
              disabled={dragging}
            />
          </View>

          <View style={styles.buttonRow}>
            <RecordButton
              gesture={buttonGesture}
              holdActive={holdActive}
              pressed={pressed}
              recordingShown={recordingShown}
              // The take as the user sees it: over once its stop is asked for (the clip may still be
              // saving), and on as soon as a start is queued behind that save.
              isRecording={(isRecording && recordStoppedAt == null) || startQueued}
              cameraReady={cameraReady}
              dragging={dragging}
            />
            {recordTip.mounted && (
              <View style={styles.recordTip} pointerEvents="none">
                <TipAnchor id="record" shown={recordTip.shown} onDismiss={recordTip.dismiss} />
              </View>
            )}
            {/* The draft in the editor, from its start; there once there's a clip. Faded out with the
                record button during a drag, like the "+". */}
            {draftId && segments.length > 0 && (
              <View style={styles.editSlot} pointerEvents="box-none">
                <Animated.View style={[CONTROLS_FADE, { opacity: dragging ? 0 : 1 }]}>
                  <EditButton
                    onPress={() => {
                      editTip.retire();
                      open({ pathname: '/editor', params: { draftId } });
                    }}
                    disabled={isRecording || dragging}
                  />
                  {editTip.mounted && (
                    <View style={StyleSheet.absoluteFill} pointerEvents="none">
                      <TipAnchor id="edit" shown={editTip.shown} onDismiss={editTip.dismiss} />
                    </View>
                  )}
                </Animated.View>
              </View>
            )}
            {/* Faded out with the record button during a drag so the trash has clear space. */}
            <Animated.View
              style={[styles.importWrap, CONTROLS_FADE, { opacity: dragging ? 0 : 1 }]}>
              <ImportButton
                onPress={importClip}
                disabled={isRecording || dragging}
                busy={isImporting}
                progress={importProgress}
              />
            </Animated.View>
          </View>

          <SegmentBar
            key={bar.key}
            segments={bar.segments}
            firstClipOverlay={
              clipsTip.mounted && (
                <TipAnchor id="clips" shown={clipsTip.shown} onDismiss={clipsTip.dismiss} />
              )
            }
            onReorder={reorderSegments}
            // Drag-to-trash deletes at once.
            onDelete={deleteSegment}
            onDragActiveChange={setDragging}
            // A tapped clip opens the editor on it (in the view last used there).
            onSelect={(id) => {
              if (!isRecording && draftId) {
                open({
                  pathname: '/editor',
                  params: { draftId, clipId: id },
                });
              }
            }}
          />
        </View>
      </View>

      {/* Over everything: the recorder's tips are callouts, which leave the shutter tappable. */}
      <TipLayer />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  // Absolutely positioned at the origin; onFocus translates it to the tapped point.
  reticle: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: RETICLE_SIZE,
    height: RETICLE_SIZE,
    borderRadius: 8,
    borderCurve: 'continuous',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.9)',
  },
  overlay: { justifyContent: 'space-between' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // Shape only — GlassPill owns the surface; ties the top bar to the glass close button.
  timerPill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 4,
    borderRadius: 14,
  },
  timerText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
  },
  topBarSide: { flex: 1, flexDirection: 'row' },
  topBarEnd: { justifyContent: 'flex-end' },
  bottom: { alignItems: 'center', gap: Spacing.three },
  // Full-width row; the record button is centered by the row itself, so its position can't
  // be disturbed by the + control.
  buttonRow: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  // The + sits at the midpoint of the gap between the record button's right edge and the
  // screen edge: 75% marks the center of the right half, +19 shifts past the button's
  // half-width (38/2), -22 centers the 44pt circle on that point.
  // Over the record button (centred in the row), for the record tip's arrow.
  recordTip: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: '50%',
    width: RECORD_BUTTON_SIZE,
    marginLeft: -RECORD_BUTTON_SIZE / 2,
  },
  importWrap: {
    position: 'absolute',
    left: '75%',
    marginLeft: RECORD_BUTTON_SIZE / 4 - 22,
    top: '50%',
    marginTop: -22,
  },
  // The gap between the screen's left edge and the record button, with the Edit button centred in
  // it: the mirror image of the "+" (centred in the right-hand gap), whatever the label's width.
  editSlot: {
    position: 'absolute',
    left: 0,
    right: '50%',
    marginRight: RECORD_BUTTON_SIZE / 2,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
