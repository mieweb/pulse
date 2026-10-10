import { useEvent } from 'expo';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { router, useLocalSearchParams } from 'expo-router';
import { Icon } from '@/components/icon';
import { useVideoPlayer, VideoView } from 'expo-video';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { shareAsync } from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { SectionHeader } from '@/components/section-header';
import { StateMessage } from '@/components/state-message';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { CloseButton } from '@/features/recorder/close-button';
import {
  ButtonHeight,
  CardShadow,
  ControlScrim,
  Opacity,
  Radius,
  Spacing,
} from '@/constants/theme';
import { TipAnchor } from '@/features/tips/tip-anchor';
import { TipLayer } from '@/features/tips/tip-callout';
import { useTip } from '@/features/tips/use-tip';
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
import { useToast } from '@/features/toast/toast-provider';
import { CaptionOverlay } from '@/features/transcription/caption-overlay';
import type { TranscriptLine } from '@/features/transcription/whisper';
import { DestinationSelector } from '@/features/upload/destination-selector';
import { shareUploadLink, watchUpload } from '@/features/upload/link-actions';
import { uploadPhaseLabel } from '@/features/upload/phase-label';
import { uploads } from '@/features/upload/upload-manager';
import { useUpload } from '@/features/upload/use-upload';
import { useUploadAnnouncement, useWatchLink } from '@/features/upload/use-uploads';
import { useParkedPlayback } from '@/hooks/use-parked-playback';
import { toFileUri } from '@/utils/file-store';
import { formatClipCount, formatDuration, hostOf } from '@/utils/format';
import { closeToHome } from '@/utils/navigation';
import { effMs } from '@/utils/segment-window';
import { userMessage } from '@/utils/user-message';

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

  const photos = useSaveToPhotos();
  const docs = useSaveToDocuments();
  const { showToast } = useToast();
  const theme = useTheme();
  // Secondary buttons and the uploading bar: cards on the grouped background, lifted by a
  // shadow (no outline), like the app's other cards.
  const elementSurface = { backgroundColor: theme.card, ...CardShadow } as const;

  // Open the merged-video caption editor (only meaningful once the merge is done).
  const openCaptionEditor = () => {
    if (state.status !== 'done' || !draftId) return;
    router.push(`/subtitles?draftId=${draftId}&videoUri=${encodeURIComponent(state.outputPath)}`);
  };

  // Uploading needs the video, so the Upload button waits for the merge. It only shows a spinner
  // while the merge runs — a failed merge has its own Retry above, so the button just stays disabled.
  const uploadReady = state.status === 'done';
  // Host plus path, so two servers on one host ("…/team-a", "…/team-b") don't read the same.
  const selectedHost = upload.selectedDestination ? hostOf(upload.selectedDestination.server) : '';
  // Local const so TS narrows the discriminated union within the UPLOAD section below — property
  // chains like `upload.state` don't stay narrowed across nested JSX the way a plain const does.
  const uState = upload.state;
  // Tapping Upload LOCKS the draft (see `assertNotUploading`) until the run settles or is
  // cancelled: no caption edits here, and leaving skips the recorder underneath — an editable
  // timeline under a locked draft — for Home.
  const uploading = uState.status === 'uploading';
  // An upload that finishes while this screen is open turns the UPLOAD section into Watch / Share
  // link (the toast still says it uploaded, and that the link was copied). Only announcements
  // newer than the one current when the screen opened count, so leaving the screen puts the
  // usual upload UI back.
  const announcement = useUploadAnnouncement(draftId ?? null);
  const [seqAtOpen] = useState(() => (draftId ? (uploads.getAnnouncement(draftId)?.seq ?? 0) : 0));
  const justFinished = announcement && announcement.seq > seqAtOpen ? announcement : null;
  const finishedLink = useWatchLink(justFinished ? (draftId ?? null) : null);
  const finished = justFinished && finishedLink ? { ...justFinished, link: finishedLink } : null;
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
      showToast({
        kind: 'error',
        title: 'Couldn’t share the video',
        message: userMessage(e, 'Try again.', 'share'),
      });
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
      {/* The section is already titled Upload: the icon and the destination say the rest.
          Middle truncation keeps the domain's end (e.g. "…mieweb.org") visible. */}
      <PrimaryButton
        label={state.status === 'merging' ? 'Preparing video…' : selectedHost || 'Upload'}
        icon="icloud.and.arrow.up"
        busy={state.status === 'merging'}
        truncateMiddle={state.status !== 'merging'}
        onPress={() => void upload.claim(upload.selectedId)}
        disabled={!upload.selectedId || !uploadReady}
        accessibilityLabel={selectedHost ? `Upload to ${selectedHost}` : 'Upload'}
      />
    </>
  );

  // The first finished export without a captions model points out Add captions, once.
  const captionsTip = useTip(
    'captions',
    state.status === 'done' && !uploading && transcription.state.status === 'no-model',
    800,
  );

  return (
    <ThemedView type="groupedBackground" style={styles.fill}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.two }]}>
        <CloseButton onPress={close} />
        {state.status === 'done' && !uploading && (
          <CaptionsButton
            status={transcription.state.status}
            hasCaptions={captionLines.length > 0}
            onEditCaptions={openCaptionEditor}
            onAddCaptions={() => router.push('/on-device-ai')}
            tip={
              captionsTip.mounted && (
                <TipAnchor
                  id="captions"
                  shown={captionsTip.shown}
                  onDismiss={captionsTip.dismiss}
                />
              )
            }
          />
        )}
      </View>

      {/* Bottom padding tracks the home indicator instead of a fixed 64pt — the difference
          goes to the preview (#196). */}
      <View style={[styles.center, { paddingBottom: insets.bottom + Spacing.three }]}>
        {state.status === 'merging' && (
          <>
            {/* The ring stands in for StateMessage's icon: it's the progress itself. */}
            <MergeProgressRing progress={state.progress} />
            <View style={styles.stateWrap}>
              <StateMessage
                title="Merging…"
                message={`Stitching ${formatClipCount(clips.length)} into one video.`}
              />
            </View>
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
                // 34pt pill + 5 each side = a 44pt tap target.
                hitSlop={5}
                // No disabled dimming while busy: the spinner stays at full strength, like
                // Photos and Files beside it.
                style={({ pressed }) => [
                  styles.smallButton,
                  elementSurface,
                  pressed && styles.pressed,
                ]}>
                {busy ? (
                  <ActivityIndicator size="small" color={theme.text} />
                ) : (
                  <>
                    <Icon
                      name="square.and.arrow.up"
                      size={14}
                      tintColor={theme.text}
                      scalesWithText
                    />
                    <ThemedText type="subheadline">Share</ThemedText>
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
                // 34pt pill + 5 each side = a 44pt tap target.
                hitSlop={5}
                style={({ pressed }) => [
                  styles.smallButton,
                  elementSurface,
                  pressed && styles.pressed,
                ]}>
                {photos.status === 'saving' ? (
                  <ActivityIndicator size="small" color={theme.text} />
                ) : photos.status === 'saved' ? (
                  <>
                    <Icon name="checkmark" size={14} tintColor={theme.text} scalesWithText />
                    <ThemedText type="subheadline">Saved</ThemedText>
                  </>
                ) : (
                  <>
                    <Icon
                      name="square.and.arrow.down"
                      size={14}
                      tintColor={theme.text}
                      scalesWithText
                    />
                    <ThemedText type="subheadline">Photos</ThemedText>
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
                // 34pt pill + 5 each side = a 44pt tap target.
                hitSlop={5}
                style={({ pressed }) => [
                  styles.smallButton,
                  elementSurface,
                  pressed && styles.pressed,
                ]}>
                {docs.status === 'saving' ? (
                  <ActivityIndicator size="small" color={theme.text} />
                ) : docs.status === 'saved' ? (
                  <>
                    <Icon name="checkmark" size={14} tintColor={theme.text} scalesWithText />
                    <ThemedText type="subheadline">Saved</ThemedText>
                  </>
                ) : (
                  <>
                    <Icon name="folder" size={14} tintColor={theme.text} scalesWithText />
                    <ThemedText type="subheadline">Files</ThemedText>
                  </>
                )}
              </Pressable>
            </View>
          </>
        )}

        {state.status === 'error' && (
          <View style={styles.stateWrap}>
            <StateMessage
              icon="exclamationmark.triangle.fill"
              tone="accent"
              title="Export failed"
              message={state.message}
              messageLines={4}>
              <PrimaryButton label="Try again" icon="arrow.clockwise" onPress={run} />
            </StateMessage>
          </View>
        )}

        {/* The UPLOAD section. The merge always runs (above) and the Upload button waits on
            `state.status === 'done'`. Shown while there's something actionable: destinations to
            pick, or a run in flight. A failed upload is a toast, not UI here — the draft is
            unpaired again, and scanning a new link is the retry. A previously-uploaded draft
            with nothing to pick shows no upload UI at all (§ post-upload UX — no persistent
            buttons). */}
        {(upload.destinations.length > 0 || uState.status === 'uploading' || finished) && (
          <View style={styles.uploadSection}>
            <SectionHeader title="Upload" />

            {uState.status === 'uploading' ? (
              <View style={[styles.uploadingBar, elementSurface]}>
                <ActivityIndicator color={theme.text} />
                {/* Phase-aware label — names the step in flight (preparing, captions,
                    manifest, thumbnail, video) instead of sitting at a
                    generic "Uploading… 0%" through all the pre-video work. It fills the row
                    (one line, tabular digits), so the spinner stays left and the ✕ stays put
                    as the percentage ticks. */}
                <ThemedText numberOfLines={1} style={styles.uploadingLabel}>
                  {uploadPhaseLabel(uState)}
                </ThemedText>
                <Pressable
                  onPress={() => void upload.cancel()}
                  // 16pt glyph + 14 each side = a 44pt tap target.
                  hitSlop={14}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel upload"
                  style={({ pressed }) => pressed && styles.pressedIcon}>
                  <Icon name="xmark" size={16} tintColor={theme.textSecondary} />
                </Pressable>
              </View>
            ) : finished ? (
              // Side by side in one 52pt row — the same space the Upload button took, so the
              // preview doesn't shrink when the upload finishes. The "link copied" toast
              // covers what the old note under these buttons said.
              <View style={styles.finishedRow}>
                <PrimaryButton
                  label="Watch"
                  icon="play.fill"
                  onPress={() => void watchUpload(finished.link.url)}
                  style={styles.rowButton}
                />
                {/* Only a link that's safe to share — never one carrying the upload token. */}
                {finished.link.shareable && (
                  <PrimaryButton
                    variant="card"
                    label="Share link"
                    icon="square.and.arrow.up"
                    onPress={() => void shareUploadLink(finished.link.url).catch(() => {})}
                    style={styles.rowButton}
                  />
                )}
              </View>
            ) : (
              selectorAndUpload
            )}
          </View>
        )}
      </View>
      {/* Android draws its tips as callouts, over everything (iOS uses the system popover here). */}
      <TipLayer />
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
  // The meta pill sits in flow above the card, so its row comes out of the height budget. Its
  // text grows with the text size (up to META_MAX_SCALE), so the row is worked out from the
  // scale rather than reserved at the largest size, which would leave a gap at the usual one.
  const { fontScale } = useWindowDimensions();
  const metaRow =
    META_LINE_HEIGHT * Math.min(fontScale, META_MAX_SCALE) + META_PILL_PAD_V * 2 + META_GAP;
  const cardWidth = frame ? Math.min(frame.width, ((frame.height - metaRow) * 9) / 16) : 0;
  const cardHeight = (cardWidth * 16) / 9;

  return (
    <View
      style={styles.previewFrame}
      onLayout={({ nativeEvent: { layout } }) =>
        setFrame({ width: layout.width, height: layout.height })
      }>
      {frame != null && (
        <View style={[styles.metaPill, ControlScrim[mode]]}>
          <ThemedText maxFontSizeMultiplier={META_MAX_SCALE} style={styles.metaText}>
            {meta}
          </ThemedText>
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
              // Android: the default SurfaceView ignores the card's clipping, so the video would
              // draw square corners over the rounded card. A TextureView clips like any view.
              surfaceType="textureView"
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
  tip,
}: {
  status: MergedTranscriptionState['status'];
  hasCaptions: boolean;
  onEditCaptions: () => void;
  onAddCaptions: () => void;
  /** The captions tip's anchor, laid over the button. */
  tip?: ReactNode;
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
      style={({ pressed }) => pressed && styles.pressed}
      accessibilityRole="button"
      accessibilityLabel={status === 'ready' && hasCaptions ? 'Edit captions' : 'Add captions'}>
      <View style={surface}>
        <Icon name="captions.bubble" size={20} weight="semibold" tintColor="#fff" />
        {tip}
      </View>
    </Pressable>
  );
}

/** The meta pill: the recorder timer pill's 4pt padding around its 16pt text (28pt at the
 * default text size), and its gap to the video — reserved out of the preview frame's height.
 * Text over video stops growing at 1.3×, so the pill can't crowd the preview out. */
const META_LINE_HEIGHT = 20;
const META_PILL_PAD_V = 4;
const META_GAP = Spacing.one + Spacing.one;
const META_MAX_SCALE = 1.3;

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
    // ratio, so the contained video fills the card with no pillarboxing. Same corners as the
    // captions editor's preview of this video.
    overflow: 'hidden',
    backgroundColor: '#000',
    borderRadius: Radius.row,
    borderCurve: 'continuous',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    // The same 16pt gutter as the header, so the ✕ and the content share an edge.
    paddingHorizontal: Spacing.three,
    // paddingBottom is inline — it tracks the safe-area inset.
  },
  // Full width, so StateMessage's actions (Try again) span the column instead of hugging the
  // text.
  stateWrap: { alignSelf: 'stretch' },
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
    minHeight: META_LINE_HEIGHT + META_PILL_PAD_V * 2,
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
    paddingVertical: META_PILL_PAD_V,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: META_GAP,
  },
  metaText: {
    color: '#fff',
    fontSize: 16,
    lineHeight: META_LINE_HEIGHT,
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
    // A floor, so a large text size grows the pill instead of clipping its label.
    minHeight: 34,
    paddingHorizontal: Spacing.three,
    borderRadius: 17,
  },
  uploadSection: { alignSelf: 'stretch', gap: Spacing.two, marginTop: Spacing.two },
  // The in-flight upload, in the Upload button's place: the same 52pt card, so nothing moves.
  uploadingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    minHeight: ButtonHeight,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.button,
    borderCurve: 'continuous',
  },
  uploadingLabel: { flex: 1, fontVariant: ['tabular-nums'] },
  pressed: { opacity: Opacity.pressed },
  pressedIcon: { opacity: Opacity.pressedGlyph },
  finishedRow: { flexDirection: 'row', gap: Spacing.two },
  rowButton: { flex: 1 },
});
