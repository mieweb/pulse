import { useEvent } from 'expo';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { router, useLocalSearchParams } from 'expo-router';
import { Icon } from '@/components/icon';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Pressable, StyleSheet, View } from 'react-native';
import { shareAsync } from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { CloseButton } from '@/features/recorder/close-button';
import { ControlScrim, Spacing } from '@/constants/theme';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
import { segmentsForDraft } from '@/db/drafts';
import { useExport } from '@/features/export/use-export';
import {
  useMergedTranscription,
  type MergedTranscriptionState,
} from '@/features/export/use-merged-transcription';
import { MergeProgressRing } from '@/features/export/merge-progress-ring';
import { useSaveToDocuments } from '@/features/export/use-save-to-documents';
import { useSaveToPhotos } from '@/features/export/use-save-to-photos';
import { CaptionOverlay } from '@/features/transcription/caption-overlay';
import { ModelSwitcherModal } from '@/features/transcription/model-switcher-modal';
import type { TranscriptLine } from '@/features/transcription/whisper';
import { DestinationSelector } from '@/features/upload/destination-selector';
import { uploadPhaseLabel } from '@/features/upload/phase-label';
import { useUpload } from '@/features/upload/use-upload';
import { useParkedPlayback } from '@/hooks/use-parked-playback';
import { toFileUri } from '@/utils/file-store';
import { formatClipCount, formatDuration, hostOf } from '@/utils/format';
import { closeToHome } from '@/utils/navigation';
import { effMs } from '@/utils/segment-window';

export default function ExportScreen() {
  const insets = useSafeAreaInsets();
  const { draftId } = useLocalSearchParams<{ draftId?: string }>();

  const { data: segments } = useLiveQuery(segmentsForDraft(draftId ?? ''), [draftId]);
  // Zero-length clips (failed native reads) can't be concatenated — drop them before merging.
  const clips = segments.filter((s) => effMs(s) > 0);

  // Stable ref (not a plain value) so `useUpload` can be called — and its `destination`/pool
  // read — before the merge finishes. It's read at enqueue time, once the merge is done. See the
  // `useUpload` doc comment.
  const mergedRef = useRef<{ path: string; durationMs: number } | null>(null);
  const upload = useUpload(draftId ?? '', clips, mergedRef);

  // The merge runs on mount: Share/Save/Preview and the upload all need the one video.
  const { state, run } = useExport(draftId ?? '', clips);
  // The upload reads `mergedRef.current` at enqueue time, not via a reactive prop — update it
  // whenever the merge's own state changes instead of threading `merged` through as a value.
  useEffect(() => {
    mergedRef.current =
      state.status === 'done' ? { path: state.outputPath, durationMs: state.durationMs } : null;
  }, [state]);

  // Transcribe the merged video once it's ready; drives the "Transcribing…" state and the caption
  // overlay/editor. Captions live on the merged timeline now — no per-clip stitching.
  const transcription = useMergedTranscription(draftId ?? '', clips, state);
  const captionLines = transcription.lines;

  // Whether the share sheet is being presented, so we can disable the button and show a spinner.
  const [busy, setBusy] = useState(false);
  // The On-device AI sheet, opened from the caption CTA when no model is selected yet.
  const [modelSheetVisible, setModelSheetVisible] = useState(false);
  const photos = useSaveToPhotos();
  const docs = useSaveToDocuments();
  const theme = useTheme();
  // Hairline ring for element-filled surfaces — the fill alone barely separates from the
  // flat background in either mode.
  const elementSurface = {
    backgroundColor: theme.backgroundElement,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
  } as const;

  // Open the merged-video caption editor (only meaningful once the merge is done).
  const openCaptionEditor = () => {
    if (state.status !== 'done' || !draftId) return;
    router.push(`/subtitles?draftId=${draftId}&videoUri=${encodeURIComponent(state.outputPath)}`);
  };

  // Uploading needs the video, so the Upload button waits for the merge. It only shows a spinner
  // while the merge runs — a failed merge has its own Retry above, so the button just stays disabled.
  const uploadReady = state.status === 'done';
  const selectedHost = upload.selectedDestination ? hostOf(upload.selectedDestination.server) : '';
  // Local const so TS narrows the discriminated union within the UPLOAD section below — property
  // chains like `upload.state` don't stay narrowed across nested JSX the way a plain const does.
  const uState = upload.state;
  // Tapping Upload LOCKS the draft (see `assertNotUploading`) until the run settles or is
  // cancelled: no caption edits here, and leaving skips the recorder underneath — an editable
  // timeline under a locked draft — for Home.
  const uploading = uState.status === 'uploading';
  const close = useCallback(() => {
    if (!uploading) closeToHome();
    else if (router.canDismiss()) router.dismissAll();
    else router.replace('/');
  }, [uploading]);
  // Android's back button would otherwise pop straight to the recorder.
  useEffect(() => {
    if (!uploading) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [uploading, close]);

  const runShare = async () => {
    if (state.status !== 'done' || busy) return;
    setBusy(true);
    try {
      await shareAsync(toFileUri(state.outputPath), { mimeType: 'video/mp4' });
    } catch (e) {
      Alert.alert('Share failed', e instanceof Error ? e.message : 'Could not share the video.');
    } finally {
      setBusy(false);
    }
  };

  // The pool selector + claim button, shared by every non-uploading state — including a draft
  // that was already uploaded before (claiming re-pairs it and restarts cleanly, see `claim`),
  // so a destination paired after a finished upload is always reachable.
  const selectorAndUpload = upload.destinations.length > 0 && (
    <>
      <DestinationSelector
        destinations={upload.destinations}
        selectedId={upload.selectedId}
        onSelect={upload.setSelectedId}
      />
      <Pressable
        onPress={() => void upload.claim(upload.selectedId)}
        disabled={!upload.selectedId || !uploadReady}
        accessibilityRole="button"
        accessibilityLabel={selectedHost ? `Upload to ${selectedHost}` : 'Upload'}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: theme.accent },
          (!upload.selectedId || !uploadReady) && styles.disabled,
          pressed && styles.pressed,
        ]}>
        {state.status === 'merging' ? (
          <>
            <ActivityIndicator color={theme.onAccent} />
            <ThemedText style={{ color: theme.onAccent }}>Preparing video…</ThemedText>
          </>
        ) : (
          <>
            <Icon name="icloud.and.arrow.up" size={18} tintColor={theme.onAccent} />
            <ThemedText style={{ color: theme.onAccent }}>Upload to {selectedHost}</ThemedText>
          </>
        )}
      </Pressable>
    </>
  );

  return (
    <ThemedView style={styles.fill}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.two }]}>
        <CloseButton onPress={close} />
        {state.status === 'done' && !uploading && (
          <CaptionsButton
            status={transcription.state.status}
            hasCaptions={captionLines.length > 0}
            onEditCaptions={openCaptionEditor}
            onAddCaptions={() => setModelSheetVisible(true)}
          />
        )}
      </View>

      {/* Bottom padding tracks the home indicator instead of a fixed 64pt — the difference
          goes to the preview (#196). */}
      <View style={[styles.center, { paddingBottom: insets.bottom + Spacing.three }]}>
        {state.status === 'merging' && (
          <>
            <MergeProgressRing progress={state.progress} />
            <ThemedText type="subtitle" style={styles.title}>
              Merging…
            </ThemedText>
            <ThemedText themeColor="textSecondary">
              Stitching {formatClipCount(clips.length)} into one video.
            </ThemedText>
          </>
        )}

        {state.status === 'done' && (
          <>
            <MergedPreview
              uri={state.outputPath}
              lines={captionLines}
              meta={`${formatClipCount(clips.length)} · ${formatDuration(state.durationMs)}`}
            />

            {/* Compact inline row — these are secondary actions; the upload button(s) below
                own the vertical space. */}
            <View style={styles.actionsRow}>
              <Pressable
                onPress={runShare}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={busy ? 'Sharing' : 'Share'}
                accessibilityState={{ disabled: busy, busy }}
                style={({ pressed }) => [
                  styles.smallButton,
                  elementSurface,
                  busy && styles.disabled,
                  pressed && styles.pressed,
                ]}>
                {busy ? (
                  <ActivityIndicator size="small" color={theme.text} />
                ) : (
                  <>
                    <Icon name="square.and.arrow.up" size={14} tintColor={theme.text} />
                    <ThemedText type="small">Share</ThemedText>
                  </>
                )}
              </Pressable>

              <Pressable
                onPress={() => void photos.save(toFileUri(state.outputPath))}
                disabled={photos.status !== 'idle'}
                accessibilityRole="button"
                accessibilityLabel={
                  photos.status === 'saved'
                    ? 'Saved to Photos'
                    : photos.status === 'saving'
                      ? 'Saving to Photos'
                      : 'Save to Photos'
                }
                accessibilityState={{
                  disabled: photos.status !== 'idle',
                  busy: photos.status === 'saving',
                }}
                style={({ pressed }) => [
                  styles.smallButton,
                  elementSurface,
                  pressed && styles.pressed,
                ]}>
                {photos.status === 'saving' ? (
                  <ActivityIndicator size="small" color={theme.text} />
                ) : photos.status === 'saved' ? (
                  <>
                    <Icon name="checkmark" size={14} tintColor={theme.text} />
                    <ThemedText type="small">Saved</ThemedText>
                  </>
                ) : (
                  <>
                    <Icon name="square.and.arrow.down" size={14} tintColor={theme.text} />
                    <ThemedText type="small">Photos</ThemedText>
                  </>
                )}
              </Pressable>

              <Pressable
                onPress={() => void docs.save(toFileUri(state.outputPath))}
                disabled={docs.status !== 'idle'}
                accessibilityRole="button"
                accessibilityLabel={
                  docs.status === 'saved'
                    ? 'Saved to Files'
                    : docs.status === 'saving'
                      ? 'Saving to Files'
                      : 'Save to Files'
                }
                accessibilityState={{
                  disabled: docs.status !== 'idle',
                  busy: docs.status === 'saving',
                }}
                style={({ pressed }) => [
                  styles.smallButton,
                  elementSurface,
                  pressed && styles.pressed,
                ]}>
                {docs.status === 'saving' ? (
                  <ActivityIndicator size="small" color={theme.text} />
                ) : docs.status === 'saved' ? (
                  <>
                    <Icon name="checkmark" size={14} tintColor={theme.text} />
                    <ThemedText type="small">Saved</ThemedText>
                  </>
                ) : (
                  <>
                    <Icon name="folder" size={14} tintColor={theme.text} />
                    <ThemedText type="small">Files</ThemedText>
                  </>
                )}
              </Pressable>
            </View>
          </>
        )}

        {state.status === 'error' && (
          <>
            <Icon name="exclamationmark.triangle.fill" size={64} tintColor={theme.accent} />
            <ThemedText type="subtitle" style={styles.title}>
              Export failed
            </ThemedText>
            <ThemedText themeColor="textSecondary" style={styles.errorMessage}>
              {state.message}
            </ThemedText>

            <View style={styles.actions}>
              <Pressable
                onPress={run}
                accessibilityRole="button"
                accessibilityLabel="Try again"
                style={({ pressed }) => [
                  styles.button,
                  { backgroundColor: theme.accent },
                  pressed && styles.pressed,
                ]}>
                <Icon name="arrow.clockwise" size={18} tintColor={theme.onAccent} />
                <ThemedText style={{ color: theme.onAccent }}>Try again</ThemedText>
              </Pressable>
            </View>
          </>
        )}

        {/* The UPLOAD section. The merge always runs (above) and the Upload button waits on
            `state.status === 'done'`. Shown while there's something actionable: destinations to
            pick, or a run in flight. A failed upload is a toast, not UI here — the draft is
            unpaired again, and scanning a new link is the retry. A previously-uploaded draft
            with nothing to pick shows no upload UI at all (§ post-upload UX — no persistent
            buttons). */}
        {(upload.destinations.length > 0 || uState.status === 'uploading') && (
          <View style={styles.uploadSection}>
            <ThemedText
              type="caption1"
              themeColor="textSecondary"
              style={styles.uploadSectionLabel}>
              UPLOAD
            </ThemedText>

            {uState.status === 'uploading' ? (
              <View style={[styles.button, elementSurface]}>
                <ActivityIndicator color={theme.text} />
                {/* Phase-aware label — names the step in flight (preparing, captions,
                    manifest, thumbnail, video) instead of sitting at a
                    generic "Uploading… 0%" through all the pre-video work. */}
                <ThemedText>{uploadPhaseLabel(uState)}</ThemedText>
                <Pressable
                  onPress={() => void upload.cancel()}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel upload">
                  <Icon name="xmark" size={16} tintColor={theme.textSecondary} />
                </Pressable>
              </View>
            ) : (
              selectorAndUpload
            )}
          </View>
        )}
      </View>

      <ModelSwitcherModal visible={modelSheetVisible} onClose={() => setModelSheetVisible(false)} />
    </ThemedView>
  );
}

/**
 * Plays the merged output. Mounts only once the merge is done, so `uri` is known at first
 * render and the player never needs a source swap. Plays once (no loop); play/pause and the
 * seek bar are expo-video's native controls (#210).
 */
function MergedPreview({
  uri,
  lines,
  meta,
}: {
  uri: string;
  lines: TranscriptLine[];
  /** Clip-count · duration readout, a pill just above the video. */
  meta: string;
}) {
  const mode = useThemeMode();
  const player = useVideoPlayer(toFileUri(uri), (p) => {
    p.timeUpdateEventInterval = 0.1;
    p.play();
  });
  // Parked playback: on end the playhead reparks at 0 (while paused), so the native play button
  // restarts cleanly instead of blipping the clip's end. Only the park side effect is used here.
  useParkedPlayback(player);
  const timeUpdate = useEvent(player, 'timeUpdate');
  const positionMs = (timeUpdate?.currentTime ?? player.currentTime) * 1000;

  // Largest 9:16 rect that fits the measured frame. Yoga can't express this — a max
  // constraint on the aspect-derived axis clamps it without re-shrinking the defined one,
  // which is exactly the off-ratio card #196 flags — so measure and do the math.
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  // The meta pill sits in flow above the card, so its row comes out of the height budget.
  const cardWidth = frame ? Math.min(frame.width, ((frame.height - META_ROW) * 9) / 16) : 0;
  const cardHeight = (cardWidth * 16) / 9;

  return (
    <View
      style={styles.previewFrame}
      onLayout={({ nativeEvent: { layout } }) =>
        setFrame({ width: layout.width, height: layout.height })
      }>
      {frame != null && (
        <View style={[styles.metaPill, ControlScrim[mode]]}>
          <ThemedText style={styles.metaText}>{meta}</ThemedText>
        </View>
      )}
      {frame != null && (
        <View style={[styles.previewCard, { width: cardWidth, height: cardHeight }]}>
          <View style={styles.previewSurface}>
            {/* Fullscreen/PiP off: captions are an RN overlay, not burned in, so they'd be lost. */}
            <VideoView
              style={StyleSheet.absoluteFill}
              player={player}
              contentFit="contain"
              nativeControls
              fullscreenOptions={{ enable: false }}
              allowsPictureInPicture={false}
            />
            <View style={styles.captionLayer} pointerEvents="none">
              <CaptionOverlay lines={lines} positionMs={positionMs} />
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * Edit/add captions, in the header opposite the ✕ — off the video so it never sits over the
 * native controls (#210). Working state → a spinner; actionable state → tappable; `idle` (merge
 * not done) → nothing. `error` is actionable: transcription failed, but the user can still open
 * the editor to add captions by hand. Same themed scrim as CloseButton on this flat screen.
 */
function CaptionsButton({
  status,
  hasCaptions,
  onEditCaptions,
  onAddCaptions,
}: {
  status: MergedTranscriptionState['status'];
  hasCaptions: boolean;
  onEditCaptions: () => void;
  onAddCaptions: () => void;
}) {
  const mode = useThemeMode();
  const surface = [styles.captionSurface, ControlScrim[mode]];
  if (status === 'transcribing' || status === 'downloading') {
    return (
      <View style={surface} accessibilityLabel="Generating captions">
        <ActivityIndicator size="small" color="#fff" />
      </View>
    );
  }
  if (status !== 'ready' && status !== 'no-model' && status !== 'error') return null;
  return (
    <Pressable
      onPress={status === 'no-model' ? onAddCaptions : onEditCaptions}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={status === 'ready' && hasCaptions ? 'Edit captions' : 'Add captions'}>
      <View style={surface}>
        <Icon name="captions.bubble" size={20} weight="semibold" tintColor="#fff" />
      </View>
    </Pressable>
  );
}

/** Meta pill height + its gap to the video — reserved out of the preview frame's height.
 * 28 = the recorder timer pill's 4pt padding around its 16pt text. */
const META_PILL_HEIGHT = 28;
const META_ROW = META_PILL_HEIGHT + Spacing.one + Spacing.one;

/** Room for expo-video's native control bar (AVPlayerViewController / Media3) at the bottom. */
const NATIVE_CONTROLS_INSET = 64;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: {
    paddingHorizontal: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // All the column height the rows below don't claim — the preview grows when the upload
  // section is absent and adapts per screen instead of fixed 90%/66% caps (#196).
  previewFrame: {
    flex: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewCard: {
    // Sized inline by MergedPreview to the largest 9:16 rect fitting previewFrame — exact
    // ratio, so the contained video fills the card with no pillarboxing.
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    // paddingBottom is inline — it tracks the safe-area inset.
  },
  title: { marginTop: Spacing.two },
  errorMessage: { textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: Spacing.two, marginTop: Spacing.five },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  previewSurface: { flex: 1 },
  // Same chrome as the recorder's preview timer pill (recorder.tsx timerPill/previewTimerPill):
  // mode-aware scrim + hairline edge, matching the ✕ and captions buttons above it.
  metaPill: {
    height: META_PILL_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: Spacing.one + Spacing.one,
  },
  metaText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
  },
  // Captions are bottom-anchored; inset them above the native control bar (#210).
  captionLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: NATIVE_CONTROLS_INSET },
  // Matches CloseButton's 40pt circle + hairline edge so the header pair reads as a set.
  captionSurface: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  smallButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    height: 34,
    paddingHorizontal: Spacing.three,
    borderRadius: 17,
  },
  uploadSection: { alignSelf: 'stretch', gap: Spacing.two, marginTop: Spacing.two },
  uploadSectionLabel: { letterSpacing: 0.5 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    height: 52,
    borderRadius: 14,
  },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.35 },
});
