import { useEvent } from 'expo';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { Icon } from '@/components/icon';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, View } from 'react-native';
import { shareAsync } from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { GlassPill } from '@/components/glass-pill';
import { CloseButton } from '@/features/recorder/close-button';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { segmentsForDraft } from '@/db/drafts';
import type { Segment } from '@/db/schema';
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
import { useToast } from '@/features/toast/toast-provider';
import { DestinationSelector } from '@/features/upload/destination-selector';
import { uploadPhaseLabel } from '@/features/upload/phase-label';
import { useUpload } from '@/features/upload/use-upload';
import { useParkedPlayback } from '@/hooks/use-parked-playback';
import { toFileUri } from '@/utils/file-store';
import { formatClipCount, formatDuration, hostOf } from '@/utils/format';
import { effMs } from '@/utils/segment-window';

/** Sum of each clip's effective duration — the summary line before the merge finishes has no merged output to read a duration from. */
const totalDurationMs = (clips: Segment[]) => clips.reduce((sum, s) => sum + effMs(s), 0);

export default function ExportScreen() {
  const insets = useSafeAreaInsets();
  const { draftId } = useLocalSearchParams<{ draftId?: string }>();

  const { data: segments } = useLiveQuery(segmentsForDraft(draftId ?? ''), [draftId]);
  // Zero-length clips (failed native reads) can't be concatenated — drop them before merging.
  const clips = segments.filter((s) => effMs(s) > 0);

  // Stable ref (not a plain value) so `useUpload` can be called — and its `destination`/pool
  // read — before the merge finishes. `uploadMerged` reads it lazily at upload time. See the
  // `useUpload` doc comment.
  const mergedRef = useRef<{ path: string; durationMs: number } | null>(null);
  const upload = useUpload(draftId ?? '', clips, mergedRef);

  // Always auto-merge: Share/Save/Preview want the merged file anyway, and a pairing can
  // arrive at any moment — merging eagerly means an upload never has to stop and ask the
  // user to export first.
  const { state, run } = useExport(clips);
  // `uploadMerged` reads `mergedRef.current` at upload time, not via a reactive prop — update it
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
  const { showToast } = useToast();

  // Open the merged-video caption editor (only meaningful once the merge is done).
  const openCaptionEditor = () => {
    if (state.status !== 'done' || !draftId) return;
    router.push(`/subtitles?draftId=${draftId}&videoUri=${encodeURIComponent(state.outputPath)}`);
  };

  // Uploading needs the merge done first. Computed so the Upload button's readiness updates
  // immediately as the merge lands.
  const selectedUploadReady = state.status === 'done';
  const selectedHost = upload.selectedDestination ? hostOf(upload.selectedDestination.server) : '';
  // Local const so TS narrows the discriminated union within the UPLOAD section below — property
  // chains like `upload.state` don't stay narrowed across nested JSX the way a plain const does.
  const uState = upload.state;

  // The tokened watch link rides the one-shot `done` state (built by the manager
  // from the session — tokens never land in the DB row).
  const watchUrl = uState.status === 'done' ? uState.resourceUrl : null;

  // A finished upload is surfaced exactly once — a themed prompt (see the modal in the JSX
  // below) offering to watch the video in the browser — then acknowledged so no "uploaded"
  // button lingers in the draft (§ post-upload UX). `done` only occurs for a run completed this
  // session (see `useUpload`), so this can't fire for a draft that was uploaded some other time.
  // "Copy link" puts the watch URL on the clipboard for sharing into chats/notes — previously
  // the URL was reachable only by opening the browser (#69's missing-watch-link gap). A custom
  // modal, not Alert.alert: an alert's Cancel row renders identically to the real actions,
  // reading as a third action — the modal dismisses via an explicit ✕ instead.
  const acknowledgeDone = upload.acknowledgeDone;
  // setStringAsync resolves boolean (true on success); the toast only confirms a real copy.
  const copyLink = useCallback(
    (url: string) => {
      Clipboard.setStringAsync(url).then(
        (ok) => {
          if (ok) showToast('Link copied');
        },
        () => {},
      );
    },
    [showToast],
  );

  // Every path out of the prompt acknowledges, which flips status off 'done' and hides it.
  const uploadPromptVisible = upload.state.status === 'done' && watchUrl != null;

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
        disabled={!upload.selectedId || !selectedUploadReady}
        accessibilityRole="button"
        accessibilityLabel={selectedHost ? `Upload to ${selectedHost}` : 'Upload'}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: theme.accent },
          (!upload.selectedId || !selectedUploadReady) && styles.disabled,
          pressed && styles.pressed,
        ]}>
        {!selectedUploadReady ? (
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
        <CloseButton />
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
              captionStatus={transcription.state.status}
              captionsLocked={uState.status === 'uploading'}
              onEditCaptions={openCaptionEditor}
              onAddCaptions={() => setModelSheetVisible(true)}
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

        {state.status === 'idle' && (
          <>
            <ThemedText type="subtitle" style={styles.title}>
              Ready to upload
            </ThemedText>
            <ThemedText themeColor="textSecondary">
              {formatClipCount(clips.length)} · {formatDuration(totalDurationMs(clips))}
            </ThemedText>

            <View style={styles.actions}>
              <Pressable
                onPress={run}
                accessibilityRole="button"
                accessibilityLabel="Export a merged copy"
                style={({ pressed }) => [styles.button, elementSurface, pressed && styles.pressed]}>
                <Icon name="film" size={18} tintColor={theme.text} />
                <ThemedText>Export a merged copy</ThemedText>
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

        {/* Merge always runs (above), so the Upload button just waits on
            `state.status === 'done'`. Shown while there's something actionable: destinations to
            pick, or a run in flight. A failed upload leaves no state here — the pairing is burned
            and the reason arrives as a toast; scanning a fresh link repopulates the selector. */}
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
                    manifest, thumbnail, video) instead of sitting at a generic
                    "Uploading… 0%" through all the pre-video work. */}
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

      {/* Upload-complete prompt — see the comment block above `acknowledgeDone`. The
          `watchUrl` guard narrows it to a string for the handlers; `visible` still gates
          presentation on `status === 'done'`. */}
      {watchUrl != null && (
        <Modal
          visible={uploadPromptVisible}
          transparent
          animationType="fade"
          onRequestClose={acknowledgeDone}>
          <View style={styles.promptBackdrop}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={acknowledgeDone}
              accessibilityLabel="Close"
            />
            <View
              style={[
                styles.promptCard,
                { backgroundColor: theme.background, borderColor: theme.border },
              ]}>
              <View style={styles.promptHeader}>
                <ThemedText type="subtitle" style={styles.promptTitle}>
                  Upload complete
                </ThemedText>
                <CloseButton onPress={acknowledgeDone} />
              </View>
              <ThemedText themeColor="textSecondary">Watch the video in your browser?</ThemedText>
              <View style={styles.promptActions}>
                <Pressable
                  onPress={() => {
                    copyLink(watchUrl);
                    acknowledgeDone();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Copy link"
                  style={({ pressed }) => [
                    styles.promptButton,
                    elementSurface,
                    pressed && styles.pressed,
                  ]}>
                  <Icon name="link" size={16} tintColor={theme.text} />
                  <ThemedText>Copy link</ThemedText>
                </Pressable>
                <Pressable
                  onPress={() => {
                    void Linking.openURL(watchUrl);
                    acknowledgeDone();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Watch"
                  style={({ pressed }) => [
                    styles.promptButton,
                    { backgroundColor: theme.accent },
                    pressed && styles.pressed,
                  ]}>
                  <Icon name="play.fill" size={16} tintColor={theme.onAccent} />
                  <ThemedText style={{ color: theme.onAccent }}>Watch</ThemedText>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </ThemedView>
  );
}

/**
 * Plays the merged output. Mounts only once the merge is done, so `uri` is known at first
 * render and the player never needs a source swap. Plays once (no loop); tap to pause or
 * replay after it ends.
 */
function MergedPreview({
  uri,
  lines,
  meta,
  captionStatus,
  captionsLocked,
  onEditCaptions,
  onAddCaptions,
}: {
  uri: string;
  lines: TranscriptLine[];
  /** Clip-count · duration readout, shown as a pill over the video. */
  meta: string;
  captionStatus: MergedTranscriptionState['status'];
  /** Captions ride the upload — hide the edit badge while a run is in flight. */
  captionsLocked: boolean;
  onEditCaptions: () => void;
  onAddCaptions: () => void;
}) {
  const player = useVideoPlayer(toFileUri(uri), (p) => {
    p.timeUpdateEventInterval = 0.1;
    p.play();
  });
  // Parked playback: on end the playhead reparks at 0 (while paused), so play always restarts
  // cleanly — replay()'s seek-then-play races an audible blip of the clip's end otherwise.
  const { isPlaying, togglePlay } = useParkedPlayback(player);
  const timeUpdate = useEvent(player, 'timeUpdate');
  const positionMs = (timeUpdate?.currentTime ?? player.currentTime) * 1000;

  // Working state → a spinner badge; actionable state → a tappable caption badge; `idle` (merge not
  // done) → nothing. `error` is actionable: transcription failed, but the user can still open the
  // editor to add captions by hand. Sits OUTSIDE the play Pressable so taps don't toggle playback.
  const working = captionStatus === 'transcribing' || captionStatus === 'downloading';
  const actionable =
    !captionsLocked &&
    (captionStatus === 'ready' || captionStatus === 'no-model' || captionStatus === 'error');

  // Largest 9:16 rect that fits the measured frame. Yoga can't express this — a max
  // constraint on the aspect-derived axis clamps it without re-shrinking the defined one,
  // which is exactly the off-ratio card #196 flags — so measure and do the math.
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null);
  const cardWidth = frame ? Math.min(frame.width, (frame.height * 9) / 16) : 0;
  const cardHeight = (cardWidth * 16) / 9;

  return (
    <View
      style={styles.previewFrame}
      onLayout={({ nativeEvent: { layout } }) =>
        setFrame({ width: layout.width, height: layout.height })
      }>
      {frame != null && (
        <View style={[styles.previewCard, { width: cardWidth, height: cardHeight }]}>
          <Pressable
            style={styles.previewSurface}
            onPress={togglePlay}
            accessibilityRole="button"
            accessibilityLabel="Toggle playback">
            <VideoView
              style={StyleSheet.absoluteFill}
              player={player}
              contentFit="contain"
              nativeControls={false}
            />
            <View style={StyleSheet.absoluteFill} pointerEvents="none">
              <CaptionOverlay lines={lines} positionMs={positionMs} />
            </View>
            {!isPlaying && (
              <View style={styles.playOverlay} pointerEvents="none">
                <GlassPill style={styles.playBadge}>
                  <Icon name="play.fill" size={28} tintColor="#fff" />
                </GlassPill>
              </View>
            )}
            <View style={styles.metaRow} pointerEvents="none">
              <GlassPill style={styles.metaPill}>
                <ThemedText style={styles.metaText}>{meta}</ThemedText>
              </GlassPill>
            </View>
          </Pressable>

          {working && (
            <GlassPill style={[styles.captionBadge, styles.captionSurface]} pointerEvents="none">
              <ActivityIndicator size="small" color="#fff" />
            </GlassPill>
          )}
          {actionable && (
            <Pressable
              onPress={captionStatus === 'no-model' ? onAddCaptions : onEditCaptions}
              hitSlop={4}
              accessibilityRole="button"
              accessibilityLabel={
                captionStatus === 'ready' && lines.length > 0 ? 'Edit captions' : 'Add captions'
              }
              style={styles.captionBadge}>
              <GlassPill style={styles.captionSurface}>
                <Icon name="captions.bubble" size={20} weight="semibold" tintColor="#fff" />
              </GlassPill>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  header: { paddingHorizontal: Spacing.three },
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
  playOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Shape only — GlassPill owns the surface (Liquid Glass on iOS 26+, dark scrim fallback).
  // Matches the recorder preview card's ▶; paddingLeft optically centers the glyph.
  playBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 4,
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
  // Clip-count · duration readout, bottom-center over the video.
  metaRow: { position: 'absolute', left: 0, right: 0, bottom: Spacing.two, alignItems: 'center' },
  metaPill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 4,
    borderRadius: 12,
  },
  metaText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.3,
  },
  // Small tappable badge in the top-right of the merged preview — edit/add captions, or a
  // spinner while transcribing/downloading. Placement here; the glass surface (sized to a
  // 48pt effective target with hitSlop, like the recorder preview card's badges) is split
  // out so the Pressable variant can own the position while GlassPill owns the surface.
  captionBadge: {
    position: 'absolute',
    top: Spacing.two,
    right: Spacing.two,
  },
  captionSurface: {
    width: 40,
    height: 40,
    borderRadius: 20,
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
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: 14,
  },
  errorBody: { flex: 1, gap: Spacing.half },
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
  // Upload-complete prompt (the custom modal replacing the old Alert).
  promptBackdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: Spacing.four,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  promptCard: {
    borderRadius: 20,
    // Hairline outline + shadow (the action-menu card treatment): in dark mode the themed
    // surface is pure black on a dimmed-black backdrop — without the outline there's no
    // separation at all.
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
    padding: Spacing.four,
    gap: Spacing.three,
    maxWidth: 420,
    width: '100%',
    alignSelf: 'center',
  },
  promptHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  promptTitle: { flex: 1 },
  promptActions: { flexDirection: 'row', gap: Spacing.two, marginTop: Spacing.one },
  promptButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    height: 44,
    borderRadius: 14,
  },
});
