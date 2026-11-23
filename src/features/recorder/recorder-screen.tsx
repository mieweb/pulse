import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { Paths } from 'expo-file-system';
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
import { END } from '@/core/clip-anchor';
import { useScreenFocusEffect } from '@/core/navigation/focus';
import { useStatusBarStyle } from '@/core/status-bar/status-bar';
import { captionsOffQuery } from '@/db/captions';
import { getSetting, setSetting } from '@/db/settings';
import { GlassPill } from '@/components/glass-pill';
import { useTextSizeKey } from '@/hooks/use-text-size-key';
import { Spacing } from '@/constants/theme';
import { flushDraftWrites } from '@/features/editor/draft-writes';
import { CameraControls } from '@/features/recorder/camera-controls';
import { holdsCamera, releaseCamera, takeCamera } from '@/features/recorder/camera-holder';
import { ExportButton } from '@/components/export-button';
import { AddMenu } from '@/features/recorder/add-menu';
import { useFromAnotherPulse } from '@/features/recorder/from-another-pulse';
import { CloseAction, CloseButton } from '@/features/recorder/close-button';
import { ContextBanner, RecorderNotice } from '@/features/recorder/context-banner';
import { EditButton } from '@/features/recorder/edit-button';
import {
  DEFAULT_LENS_LABEL,
  type LensPreset,
  LensSelector,
} from '@/features/recorder/lens-selector';
import { PermissionGate } from '@/features/recorder/permission-gate';
import { CONTROLS_FADE, RecordButton } from '@/features/recorder/record-button';
import { SegmentBar } from '@/features/recorder/segment-bar';
import { RECORD_BUTTON_SIZE } from '@/features/recorder/track-metrics';
import { checkDiskForRecording, NOT_ENOUGH_SPACE } from '@/features/recorder/low-disk';
import { MIC_COPY, MIC_FORCED_MUTE_KEY, micMuteStep } from '@/features/recorder/mic-denied';
import { useAudioFocus } from '@/features/recorder/use-audio-focus';
import { type MountedRecorder, registerRecorder } from '@/features/recorder/recorder-presence';
import { useScreenTake } from '@/features/recorder/screen-take';
import { useRecorder } from '@/features/recorder/use-recorder';
import { RETICLE_SIZE, useFocusReticle } from '@/features/recorder/use-focus-reticle';
import { useRecorderGestures } from '@/features/recorder/use-recorder-gestures';
import { useRecorderPermissions } from '@/features/recorder/use-recorder-permissions';
import { RecordingTimer } from '@/features/recorder/recording-timer';
import type { RecorderScreenProps } from '@/features/recorder/contract';
import { setClipQueuePaused } from '@/features/transcription/clip-queue';
import {
  askText,
  captionsModelPolicy,
  useCaptionsModelState,
} from '@/features/transcription/model-policy';
import { useClipTranscription } from '@/features/transcription/use-clip-transcription';
import { useToast } from '@/features/toast/toast-provider';
import { TipAnchor } from '@/features/tips/tip-anchor';
import { TipLayer } from '@/features/tips/tip-callout';
import { useTip } from '@/features/tips/use-tip';
import { muteHaptics } from '@/utils/haptics';

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

/**
 * The camera, the clip bar and the way on to the editor and Export. It never navigates: the shell
 * opens the next screen from `onEdit` / `onExport` and leaves from `onClose`, and tells the screen
 * through the focus port whether it is the one on top.
 */
export function RecorderScreen({
  draftId: initialDraftId,
  newDraft: newDraftProp,
  onEdit,
  onExport,
  onClose,
  screenCapture,
  insertAnchor: initialInsertAnchor,
}: RecorderScreenProps) {
  const insets = useSafeAreaInsets();
  // Re-measures the timer text when the system text size changes (see `useTextSizeKey`).
  const textSizeKey = useTextSizeKey();
  // What a draft made here starts with (a place's name and context), read once like the draft id.
  const [newDraft] = useState(() => newDraftProp);
  // The host place this recording is for (embedded only): the banner, the low-disk preflight and
  // a refused microphone recording without sound. Without one (the Pulse app) none of them apply.
  const hostContext = newDraft.hostContext ?? null;
  const embedded = hostContext !== null;
  const permissions = useRecorderPermissions({ micOptional: embedded });
  const { showToast } = useToast();
  const modelState = useCaptionsModelState();
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
    onCameraRemount,
    onSessionConfigured,
    toggleRecording,
    finalizeRecording,
    ensureDraft,
    insertAnchor,
    setInsertAnchor,
    getInsertAnchor,
    importClip,
    importImages,
    isImporting,
    importProgress,
    importProgressText,
    importProgressCount,
    startHoldRecording,
    endHoldRecording,
    flipCamera,
    toggleTorch,
    toggleMute,
    cycleStabilization,
    deleteSegment,
    reorderSegments,
  } = useRecorder(initialDraftId, newDraft, screenCapture, {
    insertAnchor: initialInsertAnchor,
  });
  // Clips copied from another draft go in at the insert cursor, into this draft (made if needed).
  const anotherPulse = useFromAnotherPulse({
    draftId,
    target: ensureDraft,
    anchor: getInsertAnchor,
  });

  // A refused microphone (embedded, PLAN-final §5.3): the recorder records without sound instead
  // of blocking. Denied asks first ("Record without sound?", or Settings); restricted can't be
  // allowed here, so it offers Settings only. The recorder mutes itself while the microphone is
  // refused (no audio track without access), and unmutes once it's allowed again. That it muted
  // itself is stored apart from the person's mute (`micMuteStep`): iOS ends the app when the
  // permission changes in Settings, so the unmute comes on a later launch, which reads the stored
  // mute as on. Read before acting (null until then); the Pulse app never reads it.
  const micOffer = permissions.micOffer;
  const [withoutSound, setWithoutSound] = useState(false);
  const micQuestion = micOffer?.kind === 'without-sound' && !withoutSound;
  const mutedForMic = useRef<boolean | null>(null);
  const [micFlagRead, setMicFlagRead] = useState(false);
  useEffect(() => {
    if (!embedded) return;
    let live = true;
    getSetting(MIC_FORCED_MUTE_KEY)
      .catch(() => null)
      .then((value) => {
        if (!live) return;
        mutedForMic.current = value === 'true';
        setMicFlagRead(true);
      });
    return () => {
      live = false;
    };
  }, [embedded]);
  useEffect(() => {
    if (!prefsReady || !micFlagRead || mutedForMic.current === null) return;
    const step = micMuteStep({
      offer: micOffer,
      micGranted: permissions.micGranted,
      muted,
      mutedForMic: mutedForMic.current,
    });
    if (step === 'none') return;
    const forced = step === 'mute';
    mutedForMic.current = forced;
    void setSetting(MIC_FORCED_MUTE_KEY, String(forced)).catch((e: unknown) =>
      console.warn(`[recorder] could not store the microphone mute: ${String(e)}`),
    );
    if (forced || muted) toggleMute();
  }, [prefsReady, micFlagRead, micOffer, permissions.micGranted, muted, toggleMute]);
  // Unmuting needs the microphone: ask again (or say why it can't be).
  const onToggleMute = () => {
    if (micOffer === null) toggleMute();
    else if (micOffer.kind === 'without-sound') setWithoutSound(false);
    else showToast({ kind: 'info', title: MIC_COPY.noSound, message: MIC_COPY.restricted });
  };

  // Low-disk preflight (C5, embedded): a take that starts with too little space fails partway,
  // so it doesn't start; "Not enough space" says why. True when the take may start.
  const diskAllowsTake = useCallback(() => {
    if (!embedded) return true;
    const check = checkDiskForRecording(() => Paths.availableDiskSpace);
    if (!check.ok) {
      console.warn(
        `[recorder] not starting: ${check.freeBytes} bytes free, ${check.neededBytes} needed`,
      );
      showToast({ kind: 'warning', ...NOT_ENOUGH_SPACE });
    }
    return check.ok;
  }, [embedded, showToast]);

  // True while a clip is being dragged (reorder / drag-to-trash) — hides the record button so
  // the floating trash above the bar has clear space.
  const [dragging, setDragging] = useState(false);

  // A screen take (module state, so in any recorder) owns the mic: the camera records silent and
  // audio focus isn't taken while it runs. The camera, and the rest of Pulse, stay usable; its Stop
  // shows in the recorder of the draft it goes to.
  const screen = useScreenTake(screenCapture);
  const screenLive = screen.phase !== 'idle';
  const screenHere = screenLive && screen.draftId != null && screen.draftId === draftId;
  const screenStartingHere = screen.starting && !screenLive && screen.draftId === draftId;
  const micOff = muted || screenLive;
  const takeBusy = isRecording || screenLive;
  const ScreenStopPill = screenCapture?.StopPill;
  const recordScreen = () => {
    if (isRecording || isImporting || screenLive || screen.importing) return;
    void screenCapture?.start(ensureDraft, !muted, getInsertAnchor());
  };

  // While the editor or Export is presented over this one, the recorder is unfocused — drop the
  // camera session so it isn't capturing (and burning power) behind the modal. Restored on return.
  const [focused, setFocused] = useState(true);
  // One screen opened per tap: the shell adds a screen each time, and two taps before it's shown
  // would stack two editors over the same draft. Open again once back on this screen. Edits an
  // editor just closed is still storing land first (export reads the stored clips).
  const opening = useRef(false);
  useScreenFocusEffect(
    useCallback(() => {
      opening.current = false;
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  // Light over the live camera whatever the theme: only once the camera shows (not over the
  // permission gate or the loading screens below) and only while this screen is focused, since the
  // recorder stays mounted under the editor and Export, which get the root's style back.
  const cameraShown = permissions.ready && permissions.granted && prefsReady;
  useStatusBarStyle(focused && cameraShown ? 'light' : null);
  const open = (go: () => void) => {
    if (opening.current) return;
    opening.current = true;
    void flushDraftWrites().then(go);
  };

  // Navigation from outside (a link opening its place's recorder) finalizes an in-flight take
  // first, as Close does, waits for this screen to unmount before mounting another camera, and
  // leaves this recorder alone when it is already the one the link asks for. Read through a ref:
  // registered once, it answers with the current render's values.
  const mounted = useRef<MountedRecorder>(null);
  useEffect(() => {
    mounted.current = {
      finalize: finalizeRecording,
      place: () => newDraft.context,
      draftId: () => draftId,
      ensureDraft,
      insertAnchor: getInsertAnchor,
      focused: () => focused,
    };
  });
  useEffect(
    () =>
      registerRecorder({
        finalize: () => mounted.current?.finalize() ?? Promise.resolve(),
        place: () => mounted.current?.place() ?? null,
        draftId: () => mounted.current?.draftId() ?? null,
        ensureDraft: () => mounted.current?.ensureDraft() ?? Promise.reject(new Error('unmounted')),
        insertAnchor: () => mounted.current?.insertAnchor() ?? END,
        focused: () => mounted.current?.focused() ?? false,
      }),
    [],
  );

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
  // In the embed the host can turn that off (`configure({captions: {autoGenerate: false}})`), and
  // the person can for one video (Export's Captions switch, stored on the draft).
  const { data: captionsOffRows } = useLiveQuery(captionsOffQuery(draftId ?? ''), [draftId]);
  const takesGetCaptions = captionsModelPolicy.takeGetsCaptions(
    captionsOffRows[0]?.value === 'true',
  );
  useClipTranscription(segments, focused && !takeBusy && takesGetCaptions);
  useEffect(() => {
    setClipQueuePaused(takeBusy);
  }, [takeBusy]);
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
    const shouldHold = focused && appActive && !micOff && !callActive && prefsReady;
    if (shouldHold) void acquireFocus();
    else void releaseFocus();
  }, [focused, appActive, micOff, callActive, prefsReady, acquireFocus, releaseFocus]);
  useEffect(() => () => void releaseFocus(), [releaseFocus]);

  // Audio handoff: back from a screen that played video (the editor sets a playback session), or
  // from a screen take (focus was released for it), the shared audio session returns to the
  // recorder, and the camera restart re-attaches the mic input (enableAudio keeps it on the main
  // capture session). If the restart wins the race against the session-config restore — the
  // player's post-unload writes and the acquire above are both async — the mic I/O unit starts
  // under a playback-only category and AVFoundation kills the session with -11800 (underlying
  // -10868, kAudioUnitErr_FormatNotSupported).
  // Sequence instead of race: hold the camera off (cameraActive below) for one settle beat + an
  // acquire, then restart. Detected as a render-phase transition so the same commit that
  // regains focus already holds the camera off. Muted / in-call returns skip the hold — they
  // restart video-only, and a category can't break a session with no mic input.
  const [audioHandoff, setAudioHandoff] = useState(false);
  // Back on screen, or the mic back from a screen take.
  const cameraWanted = focused && !screenLive;
  const [wasWanted, setWasWanted] = useState(cameraWanted);
  if (wasWanted !== cameraWanted) {
    setWasWanted(cameraWanted);
    // Not mid-take: holding the camera off would cut a camera take a screen take ended under.
    if (cameraWanted && !micOff && !callActive && !isRecording) setAudioHandoff(true);
  }
  // Android: another recorder opened over this one (Add clips) unbound this one's camera, so back
  // on top it mounts a new <Camera> (`cameraKey`) that binds again; restarting the old session
  // would open nothing (see camera-holder.ts). Same commit as the focus, like the handoff.
  const [cameraHolder] = useState(() => ({}));
  const [cameraKey, setCameraKey] = useState(0);
  useEffect(() => takeCamera(cameraHolder), [cameraHolder, cameraKey]);
  useEffect(() => () => releaseCamera(cameraHolder), [cameraHolder]);
  const [wasFocused, setWasFocused] = useState(focused);
  if (wasFocused !== focused) {
    setWasFocused(focused);
    if (focused && Platform.OS === 'android' && !holdsCamera(cameraHolder)) {
      setCameraKey((key) => key + 1);
      onCameraRemount();
    }
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
      } else if (!micOff && !callActive) {
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
    [reportMicPriorityError, micOff, callActive, acquireFocus],
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
    const starting = !recordingShownNow();
    if (starting && !diskAllowsTake()) {
      recordingShown.set(recordingShownNow());
      return;
    }
    // Only a tap that starts (or queues) a take waits: one that stops a take or takes back a
    // queued one must act at once, or the queued take could start during the wait and this tap
    // then stop it, leaving a short clip.
    if (starting && !micOff && !callActive) await acquireFocus();
    toggleRecording();
    recordingShown.set(recordingShownNow());
  }, [
    toggleRecording,
    recordingShownNow,
    recordingShown,
    micOff,
    callActive,
    acquireFocus,
    diskAllowsTake,
  ]);

  // Hold-to-record needs more than onToggle: acquire() is awaited, and the gesture's
  // release reaches JS straight away via scheduleOnRN — a quick press-release could run onHoldEnd
  // BEFORE the delayed startHoldRecording() (holdInitiatedRef still false, so nothing to
  // stop), and the start would then fire AFTER the gesture ended, leaving an unheld
  // in-progress recording. Every hold edge bumps a sequence number; the delayed start is
  // dropped when its hold is no longer the live one.
  const holdSeqRef = useRef(0);
  const onHoldStart = useCallback(async () => {
    const seq = ++holdSeqRef.current;
    if (!recordingShownNow() && !diskAllowsTake()) {
      recordingShown.set(recordingShownNow());
      return;
    }
    if (!micOff && !callActive) await acquireFocus();
    if (seq === holdSeqRef.current) startHoldRecording();
    recordingShown.set(recordingShownNow());
  }, [
    micOff,
    callActive,
    acquireFocus,
    startHoldRecording,
    recordingShownNow,
    recordingShown,
    diskAllowsTake,
  ]);
  const onHoldEnd = useCallback(() => {
    holdSeqRef.current++;
    endHoldRecording();
    recordingShown.set(recordingShownNow());
  }, [endHoldRecording, recordingShownNow, recordingShown]);

  // The record button's gestures, and a screen reader's activation of it: not while "Record
  // without sound?" waits for an answer.
  const recordEnabled = cameraReady && !dragging && !micQuestion;
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
    enabled: recordEnabled,
    neutralZoom,
    minZoom: device?.minZoom ?? 1,
    maxZoom: device ? Math.min(device.maxZoom, MAX_ZOOM_FACTOR) : 1,
  });

  // The camera allows haptics (see <Camera>), so mute them while a clip records: the mic would
  // pick one up. Start's haptic fires before capture begins, so it still lands.
  useEffect(() => {
    muteHaptics(takeBusy);
    return () => muteHaptics(false);
  }, [takeBusy]);

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
  const shutterIdle = focused && appActive && cameraReady && !takeBusy && !shutterTouched;
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
    return (
      <CloseAction.Provider value={() => onClose({ draftId })}>
        <PermissionGate blocked={permissions.blocked} onRequest={permissions.request} />
      </CloseAction.Provider>
    );
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

  // Close: finalize any in-flight clip (saving it into the draft) before the shell leaves, so the
  // segment isn't lost when the camera unmounts. (Hooks above the early returns register the same
  // finalize for navigation from outside, see `registerRecorder`.)
  const handleClose = () => void finalizeRecording().then(() => onClose({ draftId }));

  return (
    <View style={styles.fill} onStartShouldSetResponderCapture={closeTips}>
      {device && (
        <Camera
          key={cameraKey}
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
            if (!micOff && !callActive) void acquireFocus();
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
        <View pointerEvents="box-none">
          <View
            style={[
              styles.topBar,
              { paddingTop: insets.top + Spacing.two, paddingHorizontal: Spacing.three },
            ]}>
            <View style={styles.topBarSide}>
              <CloseButton
                onClose={handleClose}
                overVideo
                label="Close recorder"
                testID="recorder.close"
              />
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
                  onPress={() => open(() => onExport(draftId))}
                  disabled={isRecording}
                  testID="recorder.export"
                />
              )}
            </View>
          </View>
          {/* The screen take's Stop, under the top bar: clear of the rail, the lens pill and the
              shutter, which stays the camera's. */}
          {ScreenStopPill && (screenHere || screenStartingHere) && (
            <View style={styles.screenStop} pointerEvents="box-none">
              <ScreenStopPill
                began={screen.began}
                starting={screenStartingHere}
                stopping={screen.phase === 'stopping'}
                onStop={() => void screenCapture?.stop()}
              />
            </View>
          )}
          {/* Embedded: what the recording is for, then anything the person should know first. */}
          {embedded && (
            <View style={styles.notices} pointerEvents="box-none">
              <ContextBanner context={hostContext} />
              {micQuestion ? (
                <RecorderNotice
                  title={MIC_COPY.title}
                  message={MIC_COPY.body}
                  testID="recorder.micOffer"
                  actions={[
                    { label: MIC_COPY.withoutSound, onPress: () => setWithoutSound(true) },
                    { label: MIC_COPY.settings, onPress: permissions.openSettings },
                  ]}
                />
              ) : micOffer?.kind === 'settings-only' && !isRecording ? (
                <RecorderNotice
                  message={MIC_COPY.restricted}
                  testID="recorder.micOffer"
                  actions={[{ label: MIC_COPY.settings, onPress: permissions.openSettings }]}
                />
              ) : null}
              {!isRecording && modelState.kind === 'asking' && (
                <RecorderNotice
                  message={askText(modelState.model)}
                  testID="recorder.captionsModel"
                  actions={[
                    { label: 'Download', onPress: () => void captionsModelPolicy.accept() },
                    { label: 'Not now', onPress: captionsModelPolicy.decline },
                  ]}
                />
              )}
              {!isRecording && modelState.kind === 'blocked' && (
                <RecorderNotice
                  message={modelState.message}
                  testID="recorder.captionsModel"
                  actions={[
                    { label: 'Try again', onPress: () => void captionsModelPolicy.retry() },
                  ]}
                />
              )}
            </View>
          )}
        </View>

        <CameraControls
          facing={facing}
          torch={torch}
          stabilization={stabilization}
          muted={muted}
          callActive={callActive}
          screenTake={screenLive}
          recording={isRecording}
          onFlip={flipCamera}
          onToggleTorch={toggleTorch}
          onCycleStabilization={cycleStabilization}
          onToggleMute={onToggleMute}
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
              enabled={recordEnabled}
              onToggle={onToggle}
              testID="recorder.record"
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
                      open(() => onEdit(draftId));
                    }}
                    disabled={isRecording || dragging}
                    testID="recorder.edit"
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
              <AddMenu
                onImport={importClip}
                onImportImages={importImages}
                onRecordScreen={recordScreen}
                onFromAnotherPulse={anotherPulse.action?.onPress}
                // Importing works during a screen take; only a second screen take can't start.
                screenAvailable={screenCapture != null && !screenLive}
                disabled={isRecording || dragging}
                // A screen recording converting into a draft shows here too, as a Photos import.
                busy={isImporting || screen.importing}
                progress={isImporting ? importProgress : screen.progress}
                progressText={isImporting ? importProgressText : undefined}
                progressCount={isImporting ? importProgressCount : undefined}
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
            // The bar keeps the insert cursor in its place across a reorder itself.
            onReorder={reorderSegments}
            insertAnchor={insertAnchor}
            onInsertAnchorChange={setInsertAnchor}
            // Held still while a take records: it's where the take goes.
            cursorEnabled={!isRecording}
            // Drag-to-trash deletes at once.
            onDelete={deleteSegment}
            onDragActiveChange={setDragging}
            // A tapped clip opens the editor on it (in the view last used there).
            onSelect={(id) => {
              if (!isRecording && draftId) {
                open(() => onEdit(draftId, id));
              }
            }}
          />
        </View>
      </View>

      {anotherPulse.sheet}
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
  // Under the top bar, inset like it; the banner and notices stack there.
  notices: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
    gap: Spacing.two,
    alignItems: 'center',
  },
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
  screenStop: { alignItems: 'center', marginTop: Spacing.two },
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
