import { useEvent } from 'expo';
import { eq } from 'drizzle-orm';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { File } from 'expo-file-system';
import { Icon } from '@/components/icon';
import { useVideoPlayer, VideoView } from 'expo-video';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Pressable,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { shareAsync } from 'expo-sharing';
import { useSharedValue } from 'react-native-reanimated';
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
  MaxTextScale,
  Opacity,
  Radius,
  Spacing,
} from '@/constants/theme';
import { isOnline, subscribeNetwork } from '@/core/network';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
import { captionYQuery } from '@/db/captions';
import { db } from '@/db/client';
import { libraryNewerSchema } from '@/db/host-context';
import { captionsOffQuery, setCaptionsOff } from '@/db/settings';
import { renameDraft, segmentsForDraft } from '@/db/drafts';
import { drafts } from '@/db/schema';
import type { ExportScreenProps } from '@/features/export/contract';
import { exportActions } from '@/features/export/primary-action';
import { checkSend, TRIM_LABEL, uploadRulesOf } from '@/features/export/send-checks';
import { useExport } from '@/features/export/use-export';
import {
  confirmCopy,
  KEEP_DRAFT_LABEL,
  PREPARING_SEND_LABEL,
  runSend,
  sendLabel,
  stoppedSend,
  TRY_AGAIN_LABEL,
  type SendFlowDeps,
} from '@/features/export/send-flow';
import { mergeForSend } from '@/features/export/send-merge';
import { sendDraft } from '@/features/upload/core/outbox';
import { MergeProgressRing } from '@/features/export/merge-progress-ring';
import { useSaveToPhotos } from '@/features/export/use-save-to-photos';
import { useToast } from '@/features/toast/toast-provider';
import { SkiaCaption } from '@/features/transcription/skia-caption';
import { captionStyleFor } from '@/features/transcription/caption-style';
import { captionsModelPolicy } from '@/features/transcription/model-policy';
import { type DraftCaptions, useDraftCaptions } from '@/features/transcription/use-draft-captions';
import type { TranscriptLine } from '@/features/transcription/whisper';
import { uploadPhaseLabel } from '@/features/upload/core/phase-label';
import { useUploadTargets } from '@/features/upload/core/target-provider';
import { uploads } from '@/features/upload/core/upload-manager';
import { useUpload } from '@/features/upload/core/use-upload';
import { useUploadAnnouncement, useWatchLink } from '@/features/upload/core/use-uploads';
import { useParkedPlayback } from '@/hooks/use-parked-playback';
import { DRAFT_NAME_MAX_LENGTH, dropSplitSurrogate } from '@/utils/draft-name';
import { toFileUri } from '@/utils/file-store';
import { formatClipCount, formatDuration } from '@/utils/format';
import { effMs } from '@/utils/segment-window';
import { userMessage } from '@/utils/user-message';

/** No clips: a draft whose captions are off asks for none. */
const NO_CLIPS: readonly never[] = [];

/** How long after an upload finished its way back to the host is still offered here. */
const RETURN_OFFER_MS = 10 * 60_000;

/**
 * The draft's own name, its place's label and its host upload type (embedded drafts only): live,
 * for Send's checks and its button.
 */
function draftSendQuery(draftId: string) {
  return db
    .select({
      name: drafts.name,
      contextLabel: drafts.contextLabel,
      uploadTypeJson: drafts.uploadTypeJson,
    })
    .from(drafts)
    .where(eq(drafts.id, draftId));
}

/** The stored upload type, parsed, or null (no host context, or a column that doesn't parse). */
function uploadTypeOf(uploadTypeJson: string | null | undefined): unknown {
  if (!uploadTypeJson) return null;
  try {
    return JSON.parse(uploadTypeJson) as unknown;
  } catch {
    return null;
  }
}

/** The draft's `host_confirmed_at`: set once a type's confirm ran (the draft is clock-bound). */
function hostConfirmedAt(draftId: string): number | null {
  const row = db
    .select({ at: drafts.hostConfirmedAt })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .get();
  return row?.at ?? null;
}

/**
 * Where Export's Send is ('pulse' mode): ready, busy (the merge, then the host's confirm), or
 * stopped for a type with a confirm, with the words for it and whether [Try again] can help.
 */
type SendState =
  | { phase: 'idle' }
  | { phase: 'merging' | 'confirming' }
  | { phase: 'failed'; text: string; retry: boolean };

/** The merged file's size, or null when it can't be read. */
function fileBytes(path: string): number | null {
  try {
    return new File(toFileUri(path)).size ?? null;
  } catch {
    return null;
  }
}

/**
 * Merges the draft into one video, previews it, and offers the primary action (the pool's Upload,
 * or handing the video back to a host), Share and Save to Photos. It never navigates: the shell
 * leaves from `onClose` and goes back to a host page from `onBackToHost`.
 */
export function ExportScreen({
  draftId,
  primaryAction,
  policy,
  photosAddPurpose = true,
  onClose,
  onTrim,
  onBackToHost,
  onReady,
}: ExportScreenProps) {
  const insets = useSafeAreaInsets();

  const { data: segments } = useLiveQuery(segmentsForDraft(draftId), [draftId]);
  // Zero-length clips (failed native reads) can't be concatenated — drop them before merging.
  const clips = useMemo(() => segments.filter((s) => effMs(s) > 0), [segments]);

  // Stable ref (not a plain value) so `useUpload` can be called before the merge finishes. It's
  // read at enqueue time, once the merge is done. See the `useUpload` doc comment.
  const mergedRef = useRef<{ path: string; durationMs: number } | null>(null);
  const upload = useUpload(draftId, clips, mergedRef);
  // The shell's targets to pick from, its picker, and the one picked.
  const targets = useUploadTargets();

  // The merge runs on mount: Share/Save/Preview and the upload all need the one video.
  const { state, run } = useExport(draftId, clips);
  // The upload reads `mergedRef.current` at enqueue time, not via a reactive prop — update it
  // whenever the merge's own state changes instead of threading `merged` through as a value.
  useEffect(() => {
    mergedRef.current =
      state.status === 'done' ? { path: state.outputPath, durationMs: state.durationMs } : null;
  }, [state]);
  // Tell the shell the video is ready from the merge's own state, a saved export used as is
  // included: that one writes nothing to the library, so the shell can't see it there.
  useEffect(() => {
    if (state.status === 'done') {
      onReady?.({ draftId, path: state.outputPath, durationMs: state.durationMs });
    }
  }, [state, draftId, onReady]);

  // Embedded, the person can turn captions off for this video (O6): its clips aren't
  // transcribed for it from then on, and it goes without them (getDraftCaptions). The Pulse app
  // never shows the switch, so its drafts keep their captions as before.
  const captionsSwitch = captionsModelPolicy.embedded();
  const { data: captionsOffRows } = useLiveQuery(captionsOffQuery(draftId), [draftId]);
  const captionsOff = captionsOffRows[0]?.value === 'true';
  const toggleCaptions = () => {
    setCaptionsOff(draftId, !captionsOff).catch((e) =>
      showToast({
        kind: 'error',
        title: captionsOff ? 'Couldn’t turn captions on' : 'Couldn’t turn captions off',
        message: userMessage(e, 'Try again.', 'captions'),
      }),
    );
  };

  // The draft's captions, composed from its clips (made and edited in the editor), where they
  // were moved to there. No wait for the merge. Turned off, none are asked for or shown.
  const captions = useDraftCaptions(draftId, captionsOff ? NO_CLIPS : clips);
  const { data: captionRows } = useLiveQuery(captionYQuery(draftId), [draftId]);
  const captionY = captionRows[0]?.captionY ?? null;

  // Whether the share sheet is being presented, so we can disable the button and show a spinner.
  const [busy, setBusy] = useState(false);

  const photos = useSaveToPhotos();
  const { showToast } = useToast();
  const theme = useTheme();
  // Secondary buttons and the uploading bar: cards on the grouped background, lifted by a
  // shadow (no outline), like the app's other cards.
  const elementSurface = { backgroundColor: theme.card, ...CardShadow } as const;

  // A host's upload type (C7): requireName and requireOnline hold the primary action back, and
  // over its maxBytes a warning comes before Send. A draft without one (the Pulse app) has no rules.
  const { data: sendRows } = useLiveQuery(draftSendQuery(draftId), [draftId]);
  const uploadType = useMemo(() => uploadTypeOf(sendRows[0]?.uploadTypeJson), [sendRows]);
  const rules = useMemo(() => uploadRulesOf(uploadType), [uploadType]);
  const draftName = sendRows[0]?.name ?? null;
  const contextLabel = sendRows[0]?.contextLabel ?? null;

  // Uploading needs the video, so the Upload button waits for the merge. It only shows a spinner
  // while the merge runs — a failed merge has its own Retry above, so the button just stays disabled.
  const uploadReady = state.status === 'done';
  // What the Upload button is called: the picked target's name (the provider's). Send ('pulse'
  // mode) is one button like "Use this video", named by the draft's upload type.
  const actions = exportActions({
    primaryAction:
      primaryAction.kind === 'send'
        ? { kind: 'use-video', label: sendLabel(rules, contextLabel) }
        : primaryAction,
    policy,
    photosAddPurpose,
    merging: state.status === 'merging',
    destination: targets.picked,
  });
  const pool = actions.primary.kind === 'upload';
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
  const announcement = useUploadAnnouncement(draftId || null);
  const [seqAtOpen] = useState(() => (draftId ? (uploads.getAnnouncement(draftId)?.seq ?? 0) : 0));
  const justFinished = announcement && announcement.seq > seqAtOpen ? announcement : null;
  const finishedLink = useWatchLink(justFinished ? draftId || null : null);
  const finished = justFinished && finishedLink ? { ...justFinished, link: finishedLink } : null;
  // The host page a place's link came from, to go back to once the upload is in. It rides the
  // upload's announcement, so it is still here after this screen was left and opened again while
  // the upload ran — and for a while after it finished, which `finished` alone (an upload that
  // ended while this screen was open) doesn't cover.
  const [openedAt] = useState(() => Date.now());
  const back =
    onBackToHost && announcement && (justFinished || announcement.at > openedAt - RETURN_OFFER_MS)
      ? targets.backToHost(announcement.returnTo)
      : null;
  const backButton = back && (
    <>
      {/* Says where it leads: the host ends the label, which is never cut, only wrapped. */}
      <PrimaryButton
        label={back.label}
        icon="arrow.uturn.backward"
        truncate="never"
        onPress={() => onBackToHost?.(back.url)}
      />
      {back.unusualHost && (
        <ThemedText type="footnote" themeColor="warning">
          This address contains unusual characters. It may imitate another site’s name.
        </ThemedText>
      )}
    </>
  );
  // Send ('pulse' mode, send-flow.ts). While it runs (the merge, the host's confirm) the screen
  // stays: X and Android back wait, so a clock action can't succeed behind a flow that ended.
  const [send, setSend] = useState<SendState>({ phase: 'idle' });
  const sending = send.phase === 'merging' || send.phase === 'confirming';
  const sendingRef = useRef(false);
  const close = useCallback(() => {
    if (sendingRef.current) return;
    onClose({ draftLocked: uploading });
  }, [onClose, uploading]);

  const online = useSyncExternalStore(subscribeNetwork, isOnline, isOnline);
  const outputPath = state.status === 'done' ? state.outputPath : null;
  const exportBytes = useMemo(
    () => (rules?.maxBytes != null && outputPath ? fileBytes(outputPath) : null),
    [rules, outputPath],
  );
  // A library a newer Pulse migrated takes no name (only edits are refused; it still sends), so
  // the name field goes and requireName doesn't hold it back.
  const editable = !libraryNewerSchema();
  const sendCheck = checkSend({ rules, name: draftName, online, exportBytes, editable });
  // Checked again at the tap, with the network as it is then.
  const sendAllowedNow = () =>
    checkSend({ rules, name: draftName, online: isOnline(), exportBytes, editable }).block === null;
  const submitName = (input: string) => {
    const name = dropSplitSurrogate(input).trim() || null;
    if (name === draftName) return;
    renameDraft(draftId, name).catch((e) =>
      showToast({
        kind: 'error',
        title: 'Couldn’t name the video',
        message: userMessage(e, 'Try again.', 'rename'),
      }),
    );
  };
  // Android's back button would otherwise pop straight to the recorder.
  useEffect(() => {
    if (!uploading && !sending) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [uploading, sending, close]);

  const copy = confirmCopy(uploadType);
  const startSend = async () => {
    if (primaryAction.kind !== 'send' || sendingRef.current) return;
    sendingRef.current = true;
    primaryAction.onSending?.(true);
    setSend({ phase: 'merging' });
    const deps: SendFlowDeps = {
      isOnline,
      sendDraft,
      merge: () => mergeForSend(draftId),
      confirmedAt: hostConfirmedAt,
    };
    const outcome = await runSend({ draftId, rules, name: draftName, editable }, deps, (phase) =>
      setSend({ phase }),
    );
    sendingRef.current = false;
    // A Send that went ends the flow (onSent); any other lets a held host close through.
    if (outcome.status !== 'sent') primaryAction.onSending?.(false);
    switch (outcome.status) {
      case 'sent':
        setSend({ phase: 'idle' });
        primaryAction.onSent(outcome.sent);
        return;
      case 'blocked':
        // The line under the button says why (sendCheck renders it with the network as it is).
        setSend({ phase: 'idle' });
        return;
      case 'confirmFailed':
      case 'tooLarge':
      case 'failed': {
        const message = outcome.status === 'tooLarge' ? outcome.text : outcome.message;
        // A type with a confirm stays on its failure (send-flow.ts `stoppedSend`); any other type
        // says why and stays ready to Send again.
        const stopped = stoppedSend(outcome, uploadType);
        if (stopped) {
          console.warn(`[export] Send stopped (${outcome.status}): ${message}`);
          setSend({ phase: 'failed', ...stopped });
          return;
        }
        setSend({ phase: 'idle' });
        showToast({
          kind: 'error',
          title: 'Couldn’t send the video',
          message:
            outcome.status === 'tooLarge' ? message : userMessage(message, 'Try again.', 'send'),
        });
        return;
      }
    }
  };

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
    }
    setBusy(false);
  };

  // The pool selector + claim button, shared by every non-uploading state — including a draft
  // that was already uploaded before (claiming re-pairs it and restarts cleanly, see `claim`),
  // so a destination paired after a finished upload is always reachable.
  const selectorAndUpload = (targets.available || targets.reopen) && (
    <>
      {/* The draft's own destination is gone, and it never falls back to another one. */}
      {targets.reopen && (
        <ThemedText type="footnote" themeColor="textSecondary" accessibilityRole="text">
          {targets.reopen}
        </ThemedText>
      )}
      {targets.available && (
        <>
          {targets.picker}
          {/* The section is already titled Upload: the icon and the destination say the rest.
              Middle truncation keeps the domain's end (e.g. "…mieweb.org") visible. */}
          <PrimaryButton
            label={actions.primary.label}
            icon="icloud.and.arrow.up"
            busy={state.status === 'merging'}
            truncate={state.status !== 'merging' ? 'middle' : undefined}
            onPress={() => void targets.resolvePicked().then(upload.claim)}
            disabled={!targets.picked || !uploadReady}
            accessibilityLabel={actions.primary.accessibilityLabel}
            testID="export.primary"
          />
        </>
      )}
    </>
  );

  return (
    <ThemedView type="groupedBackground" style={styles.fill}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.two }]}>
        <CloseButton onClose={close} testID="export.close" />
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
              // What the upload will carry: the captions once every clip that speaks has its
              // words (getDraftCaptions sends none before), so the preview never shows more.
              lines={!captionsOff && uploadCarries(captions) ? captions.lines : []}
              captionY={captionY}
              meta={`${formatClipCount(clips.length)} · ${formatDuration(state.durationMs)}`}
              note={captionsOff ? null : <CaptionsNote captions={captions} />}
            />

            {/* Embedded: captions for this video, on unless the person turns them off. */}
            {captionsSwitch && (
              <Pressable
                onPress={toggleCaptions}
                disabled={uploading}
                accessibilityRole="switch"
                accessibilityLabel="Captions"
                accessibilityState={{ checked: !captionsOff, disabled: uploading }}
                testID="export.captions"
                // 34pt pill + 5 each side = a 44pt tap target.
                hitSlop={5}
                style={({ pressed }) => [
                  styles.smallButton,
                  elementSurface,
                  uploading && styles.disabled,
                  pressed && styles.pressed,
                ]}>
                <Icon
                  name={captionsOff ? 'captions.bubble' : 'captions.bubble.fill'}
                  size={14}
                  tintColor={theme.text}
                  scalesWithText
                />
                <ThemedText type="subheadline">
                  {captionsOff ? 'Captions off' : 'Captions on'}
                </ThemedText>
              </Pressable>
            )}

            {/* The host's type asks for a name: the field to give one. */}
            {rules?.requireName && editable && (
              <TextInput
                defaultValue={draftName ?? ''}
                placeholder="Name this video"
                placeholderTextColor={theme.textSecondary}
                maxLength={DRAFT_NAME_MAX_LENGTH}
                maxFontSizeMultiplier={MaxTextScale}
                returnKeyType="done"
                accessibilityLabel="Video name"
                onEndEditing={(e) => submitName(e.nativeEvent.text)}
                style={[styles.nameInput, elementSurface, { color: theme.text }]}
                testID="export.name"
              />
            )}

            {/* Over the host's size cap: said before Send, with the way to make it smaller. */}
            {sendCheck.tooLarge && (
              <View style={styles.sendNote} accessibilityLiveRegion="polite">
                <ThemedText type="footnote" themeColor="warning" style={styles.sendNoteText}>
                  {sendCheck.tooLarge.text}
                </ThemedText>
                {/* Trim only where the shell can take the person to the editor (onTrim). A flow
                    opened straight on Export has none: the warning stays, Send isn't blocked. */}
                {onTrim && (
                  <Pressable
                    onPress={onTrim}
                    accessibilityRole="button"
                    hitSlop={12}
                    testID="export.trim"
                    style={({ pressed }) => pressed && styles.pressed}>
                    <ThemedText type="footnote" themeColor="accent" style={styles.trimLabel}>
                      {TRIM_LABEL}
                    </ThemedText>
                  </Pressable>
                )}
              </View>
            )}

            {/* Inside a host: hand the video back to it. */}
            {primaryAction.kind === 'use-video' && (
              <PrimaryButton
                label={actions.primary.label}
                icon="checkmark"
                accessibilityLabel={actions.primary.accessibilityLabel}
                accessibilityHint={sendCheck.blockText ?? undefined}
                disabled={sendCheck.block !== null}
                testID="export.primary"
                onPress={() => {
                  if (!sendAllowedNow()) return;
                  primaryAction.onUse({
                    draftId,
                    path: state.outputPath,
                    durationMs: state.durationMs,
                  });
                }}
              />
            )}
            {/* Inside a host, 'pulse' mode: Send through Pulse's outbox. */}
            {primaryAction.kind === 'send' && send.phase !== 'failed' && (
              <PrimaryButton
                label={
                  send.phase === 'merging'
                    ? PREPARING_SEND_LABEL
                    : send.phase === 'confirming'
                      ? copy.confirming
                      : actions.primary.label
                }
                icon="icloud.and.arrow.up"
                busy={sending}
                accessibilityLabel={
                  send.phase === 'confirming' ? copy.confirming : actions.primary.accessibilityLabel
                }
                accessibilityHint={sendCheck.blockText ?? undefined}
                disabled={sendCheck.block !== null || sending}
                testID="export.primary"
                onPress={() => void startSend()}
              />
            )}
            {/* The host's confirm failed: nothing was sent and the draft is kept as it is. */}
            {primaryAction.kind === 'send' && send.phase === 'failed' && (
              <View style={styles.sendFailed}>
                <ThemedText
                  type="footnote"
                  themeColor="warning"
                  accessibilityLiveRegion="polite"
                  testID="export.sendFailed">
                  {send.text}
                </ThemedText>
                <View style={styles.finishedRow}>
                  {send.retry && (
                    <PrimaryButton
                      label={TRY_AGAIN_LABEL}
                      icon="arrow.clockwise"
                      disabled={sendCheck.block !== null}
                      accessibilityHint={sendCheck.blockText ?? undefined}
                      onPress={() => void startSend()}
                      style={styles.rowButton}
                      testID="export.sendRetry"
                    />
                  )}
                  <PrimaryButton
                    variant="card"
                    label={KEEP_DRAFT_LABEL}
                    onPress={primaryAction.onKeepDraft}
                    style={styles.rowButton}
                    testID="export.keepDraft"
                  />
                </View>
              </View>
            )}
            {/* Why the primary action is held back: a name, or a connection. */}
            {sendCheck.blockText && (
              <ThemedText
                type="footnote"
                themeColor="textSecondary"
                accessibilityLiveRegion="polite"
                testID="export.sendBlocked">
                {sendCheck.blockText}
              </ThemedText>
            )}

            {/* Compact inline row — these are secondary actions; the upload button(s) below
                own the vertical space. */}
            {(actions.share || actions.saveToPhotos) && (
              <View style={styles.actionsRow}>
                {actions.share && (
                  <Pressable
                    onPress={runShare}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={busy ? 'Sharing' : 'Share'}
                    testID="export.share"
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
                )}

                {actions.saveToPhotos && (
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
                    testID="export.saveToPhotos"
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
                )}
              </View>
            )}
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
            unpaired again, and a new link is the retry (for a draft recorded for a place, the
            line that says to open a new link for it). A previously-uploaded draft with nothing to
            pick shows no upload UI at all (§ post-upload UX — no persistent buttons), but for
            the way back to the host its upload just came from. */}
        {pool &&
          (targets.available ||
            targets.reopen ||
            uState.status === 'uploading' ||
            finished ||
            back) && (
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
                // covers what the old note under these buttons said. An upload to the draft's own
                // place adds "Back to <app>" above them, the step the person most likely wants next.
                <View style={styles.finishedStack}>
                  {backButton}
                  <View style={styles.finishedRow}>
                    <PrimaryButton
                      variant={back ? 'card' : 'filled'}
                      label="Watch"
                      icon="play.fill"
                      onPress={() => void targets.watch(finished.link.url)}
                      style={styles.rowButton}
                    />
                    {/* Only a link that's safe to share — never one carrying the upload token. */}
                    {finished.link.shareable && (
                      <PrimaryButton
                        variant="card"
                        label="Share link"
                        icon="square.and.arrow.up"
                        onPress={() => void targets.share(finished.link.url).catch(() => {})}
                        style={styles.rowButton}
                      />
                    )}
                  </View>
                </View>
              ) : back ? (
                // An upload that finished before this screen was opened again: its way back, then
                // whatever there is to upload to next.
                <View style={styles.finishedStack}>
                  {backButton}
                  {selectorAndUpload}
                </View>
              ) : (
                selectorAndUpload
              )}
            </View>
          )}
      </View>
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
  captionY,
  meta,
  note,
}: {
  uri: string;
  lines: readonly TranscriptLine[];
  /** Where the captions were moved to in the editor (null: the default place). */
  captionY: number | null;
  /** Clip-count · duration readout, a pill just above the video. */
  meta: string;
  /** Over the top of the video: what's missing from the captions, if anything. */
  note?: ReactNode;
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
  // The player's time for the caption (drawn on the UI thread, as in the editor).
  const timeMs = useSharedValue(positionMs);
  useEffect(() => {
    timeMs.set(positionMs);
  }, [positionMs, timeMs]);
  const captionStyle = useMemo(() => captionStyleFor(captionY), [captionY]);

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
            {/* The captions as the editor draws them, where they were placed; shows only. */}
            {cardWidth > 0 && cardHeight > 0 && (
              <SkiaCaption
                lines={lines}
                timeMs={timeMs}
                style={captionStyle}
                width={cardWidth}
                height={cardHeight}
              />
            )}
            {note}
          </View>
        </View>
      )}
    </View>
  );
}

/** Whether the upload carries the captions shown (getDraftCaptions' rule): every clip has its
 * words, or no model is chosen (the hand-edited captions alone go). */
function uploadCarries(captions: DraftCaptions): boolean {
  const st = captions.state.status;
  return st === 'ready' || st === 'no-model';
}

/**
 * What the upload's captions will be missing, over the video: captions still being made or
 * waiting for their model's download (an upload now goes without them), or clips the model
 * couldn't caption (no captions there; a tap tries them again). Nothing when they're complete,
 * or with no captions model chosen.
 */
function CaptionsNote({ captions }: { captions: DraftCaptions }) {
  const mode = useThemeMode();
  const st = captions.state.status;
  let text: string | null = null;
  let onPress: (() => void) | undefined;
  if (st === 'transcribing' || st === 'downloading') {
    text = 'Captions are still being made. Uploading now sends the video without them.';
  } else if (st === 'needs-download') {
    text = 'Captions need their model downloaded. Uploading now sends the video without them.';
  } else if (st === 'ready' && captions.failed.length) {
    text = `Couldn’t caption ${formatClipCount(captions.failed.length)}. Tap to try again.`;
    onPress = captions.retry;
  }
  if (!text) return null;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      style={[styles.captionsNote, ControlScrim[mode]]}>
      <ThemedText style={styles.captionsNoteText}>{text}</ThemedText>
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
  captionsNote: {
    position: 'absolute',
    top: Spacing.two,
    alignSelf: 'center',
    maxWidth: '86%',
    paddingHorizontal: Spacing.two,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  captionsNoteText: { color: '#fff', fontSize: 13, textAlign: 'center' },
  metaText: {
    color: '#fff',
    fontSize: 16,
    lineHeight: META_LINE_HEIGHT,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
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
  disabled: { opacity: Opacity.disabled },
  // The host type's name field: a card like the secondary buttons, as tall as a row.
  nameInput: {
    alignSelf: 'stretch',
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.button,
    borderCurve: 'continuous',
    fontSize: 17,
  },
  sendNote: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
  },
  sendNoteText: { textAlign: 'center' },
  trimLabel: { fontWeight: '600' },
  pressedIcon: { opacity: Opacity.pressedGlyph },
  finishedStack: { gap: Spacing.two },
  finishedRow: { flexDirection: 'row', gap: Spacing.two },
  rowButton: { flex: 1 },
  sendFailed: { alignSelf: 'stretch', gap: Spacing.two },
});
