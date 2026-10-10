import { useEvent } from 'expo';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useLocalSearchParams, router } from 'expo-router';
import { Icon, type IconName } from '@/components/icon';
import { GlassPill } from '@/components/glass-pill';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  interpolate,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  ZoomIn,
  ZoomOut,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { StateMessage } from '@/components/state-message';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { EaseOut, ListReflowMs } from '@/constants/motion';
import { ControlScrim, Opacity, Radius, Spacing } from '@/constants/theme';
import { segmentsForDraft } from '@/db/drafts';
import { clearEditedTranscript, getDraftTranscriptRow } from '@/db/transcripts';
import { selectedModelQuery } from '@/db/settings';
import { CloseButton } from '@/features/recorder/close-button';
import { useToast } from '@/features/toast/toast-provider';
import { CaptionOverlay } from '@/features/transcription/caption-overlay';
import { CueRow } from '@/features/transcription/cue-row';
import { CueToolbar } from '@/features/transcription/cue-toolbar';
import { resolveSelectedModel } from '@/features/transcription/models';
import { useAutosaveTranscript } from '@/features/transcription/use-autosave-transcript';
import { useSubtitleEditor, type Cue } from '@/features/transcription/use-subtitle-editor';
import { parseTranscriptLines, type TranscriptLine } from '@/features/transcription/whisper';
import { useParkedPlayback } from '@/hooks/use-parked-playback';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
import { toFileUri } from '@/utils/file-store';
import { effMs, segmentSignature } from '@/utils/segment-window';

export default function SubtitlesScreen() {
  // Edits the MERGED video's captions. `videoUri` is the merged export output, passed from the
  // export screen; `draftId` anchors the single draft transcript row that edits persist to.
  const { draftId, videoUri } = useLocalSearchParams<{ draftId?: string; videoUri?: string }>();
  const [data, setData] = useState<{
    signature: string;
    initial: TranscriptLine[];
    autoLines: TranscriptLine[];
    savedJson: string | null;
  } | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!draftId || !videoUri) return setMissing(true);
      // Signature snapshot of the current segment set — the same key export/transcription use, so
      // an autosave here is tied to exactly the timeline the shown merged video was cut from.
      const segments = await segmentsForDraft(draftId);
      const clips = segments.filter((s) => effMs(s) > 0);
      const signature = segmentSignature(clips);
      const row = await getDraftTranscriptRow(draftId);
      const autoLines = parseTranscriptLines(row?.lines ?? null);
      const savedJson = row?.editedLines ?? null;
      const initial = savedJson ? parseTranscriptLines(savedJson) : autoLines;
      if (alive) setData({ signature, initial, autoLines, savedJson });
    })();
    return () => {
      alive = false;
    };
  }, [draftId, videoUri]);

  if (missing) {
    return (
      <ThemedView type="groupedBackground" style={[styles.fill, styles.centerAll]}>
        {/* A full-width wrap so the Go back button spans the column like the app's other
            state actions, rather than hugging its label. */}
        <View style={styles.stateWrap}>
          <StateMessage
            icon="captions.bubble"
            title="Captions unavailable"
            message="Export the video first.">
            <PrimaryButton variant="card" label="Go back" onPress={() => router.back()} />
          </StateMessage>
        </View>
      </ThemedView>
    );
  }

  if (!data) {
    return (
      <ThemedView type="groupedBackground" style={[styles.fill, styles.centerAll]}>
        <ActivityIndicator />
      </ThemedView>
    );
  }

  return (
    <Editor
      key={videoUri}
      draftId={draftId!}
      signature={data.signature}
      videoUri={videoUri!}
      initial={data.initial}
      autoLines={data.autoLines}
      savedJson={data.savedJson}
    />
  );
}

/**
 * Optimistic caption editor. No Save button: every edit applies immediately (undo/redo in the
 * header) and persists via a debounced autosave. Three modes:
 *  - browse: preview over the cue list, follows playback;
 *  - timing (a cue selected, keyboard down): a slim CueToolbar (times + split/merge/delete)
 *    docks under the preview;
 *  - text (selected row tapped again): the row's text becomes an inline input, keyboard up,
 *    the preview shrinks to keep the row visible.
 * The karaoke word highlight renders both on the video (CaptionOverlay) and in the playing cue
 * row (see CueRow).
 */
function Editor({
  draftId,
  signature,
  videoUri,
  initial,
  autoLines,
  savedJson,
}: {
  draftId: string;
  signature: string;
  videoUri: string;
  initial: TranscriptLine[];
  autoLines: TranscriptLine[];
  savedJson: string | null;
}) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { showUndoToast } = useToast();
  const editor = useSubtitleEditor(initial);

  // On-device AI model in use for this draft's captions — surfaced here (not just at first pick)
  // so the user can switch models without leaving the caption editor.
  const { data: modelRow } = useLiveQuery(selectedModelQuery, []);
  const selectedModel = resolveSelectedModel(modelRow[0]?.value);

  const player = useVideoPlayer(toFileUri(videoUri), (p) => {
    p.timeUpdateEventInterval = 0.1;
    p.loop = false;
  });
  const timeUpdate = useEvent(player, 'timeUpdate');
  const { isPlaying, seekTo } = useParkedPlayback(player);
  const posCs = (timeUpdate?.currentTime ?? player.currentTime) * 100;
  // Latest `seekTo` for the row callbacks below, which must keep one identity across renders.
  const seekToRef = useRef(seekTo);
  useEffect(() => {
    seekToRef.current = seekTo;
  });

  const { toLines, setText, endCoalescing, undo } = editor;
  const lines = useMemo(() => toLines(), [toLines]);
  const { markCleared } = useAutosaveTranscript({
    draftId,
    signature,
    lines,
    dirty: editor.dirty,
    savedJson,
  });

  // Reset to automatic captions is one undoable edit (header Undo, or the toast's, brings the
  // edits back). The row follows the cues: whenever they ARE the reset list — the reset itself,
  // or an undo/redo back to it — the row is unlocked again (`clearEditedTranscript`, re-armed
  // gate), and undoing away from it makes the editor dirty so the autosave locks it with the
  // edits. Declared after useAutosaveTranscript so this runs after its effect and cancels the
  // save it would otherwise queue for the reset list.
  const resetCuesRef = useRef<Cue[] | null>(null);
  const cuesRef = useRef(editor.cues);
  // The reset toast's closer, while its Undo can still act (see onResetToAuto).
  const closeResetToastRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    cuesRef.current = editor.cues;
    if (editor.cues !== resetCuesRef.current) {
      // Any edit after the reset (or an undo off it) makes the toast's Undo a dead button — it
      // only undoes the reset while the reset is the latest step. Close it; the header Undo
      // still walks back through every step, the reset included.
      closeResetToastRef.current?.();
      closeResetToastRef.current = null;
      return;
    }
    markCleared();
    void clearEditedTranscript(draftId);
  }, [editor.cues, markCleared, draftId]);

  // Selection drives the mode; both ids are cleared/derived defensively — a stale id (cue removed
  // by undo/delete/split) simply resolves to no cue and the screen falls back to browse mode.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const selCue = editor.cues.find((c) => c.id === selectedId) ?? null;
  const mode: 'browse' | 'timing' | 'text' =
    selCue && editingId === selCue.id ? 'text' : selCue ? 'timing' : 'browse';

  // Text mode shrinks the preview so the edited row stays above the keyboard; it eases between
  // the two widths instead of snapping (0 = full, 1 = compact).
  const compact = useSharedValue(mode === 'text' ? 1 : 0);
  useEffect(() => {
    compact.set(withTiming(mode === 'text' ? 1 : 0, { duration: 250, easing: EaseOut }));
  }, [mode, compact]);
  const previewWidth = useAnimatedStyle(() => ({
    width: `${interpolate(compact.get(), [0, 1], [PREVIEW_FULL, PREVIEW_COMPACT])}%` as const,
  }));
  // The caption and ▶ layer is laid out once, at the full preview's size, and scaled with the
  // card off the same `compact` value — so the caption text and the badge shrink in step with
  // the width instead of switching size on the first frame of a 250ms ease. Scaling (rather
  // than swapping font sizes when the ease ends) keeps the layout fixed: the caption never
  // rewraps mid-animation, and browsing — where captions are actually read — is at 1×, drawn
  // natively. Text mode shows them at 0.64× on a thumbnail-sized preview, where a slightly
  // softer bitmap scale doesn't matter. Scale only: the ▶ is glass, which must never sit under
  // an opacity.
  const { width: windowWidth } = useWindowDimensions();
  const layerWidth = (windowWidth * PREVIEW_FULL) / 100;
  const layerScale = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(compact.get(), [0, 1], [1, PREVIEW_COMPACT / PREVIEW_FULL]) }],
  }));

  // The list glides when the toolbar docks or the footer leaves (browse ↔ timing), but not into
  // or out of text mode: there the preview's width animation and the KeyboardAvoidingView's
  // padding already move it, and a layout transition on top would chase them frame by frame.
  const [modeChange, setModeChange] = useState({ from: mode, to: mode });
  if (modeChange.to !== mode) setModeChange({ from: modeChange.to, to: mode });
  const reflowList = mode !== 'text' && modeChange.from !== 'text';

  // Rows glide (and a removed one fades) only in the render that shows a structural edit —
  // delete, split, merge. Typing changes the list too, and must never animate the row being
  // typed in. The handler arms it with the list it edits; the next list is the edited one, and
  // anything after that (typing, undo) is no longer it. The timer disarms it once the glide is
  // over (or after a no-op edit, which never produces a next list).
  const [rowsEdit, setRowsEdit] = useState<{ from: Cue[]; to: Cue[] | null } | null>(null);
  if (rowsEdit && !rowsEdit.to && editor.cues !== rowsEdit.from) {
    setRowsEdit({ from: rowsEdit.from, to: editor.cues });
  }
  const rowsReflow = rowsEdit != null && rowsEdit.to === editor.cues;
  useEffect(() => {
    if (!rowsEdit) return;
    const timer = setTimeout(() => setRowsEdit(null), ListReflowMs);
    return () => clearTimeout(timer);
  }, [rowsEdit]);
  const armRowsReflow = () => setRowsEdit({ from: editor.cues, to: null });

  const playingId = useMemo(() => {
    const c = editor.cues.find((x) => posCs >= x.t0 && posCs <= x.t1);
    return c?.id ?? null;
  }, [editor.cues, posCs]);

  const scrollRef = useRef<ScrollView>(null);
  const offsets = useRef<Map<string, number>>(new Map());

  // Playback follow: auto-scroll to the playing cue, but yield while a cue is selected/being
  // edited and for a beat after the user scrolls the list themselves.
  const followSuspendedRef = useRef(false);
  const suspendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (selectedId || editingId || !playingId || followSuspendedRef.current) return;
    const y = offsets.current.get(playingId);
    if (y != null) scrollRef.current?.scrollTo({ y: Math.max(0, y - 96), animated: true });
  }, [playingId, selectedId, editingId]);
  const onUserScrollStart = () => {
    followSuspendedRef.current = true;
    if (suspendTimerRef.current) clearTimeout(suspendTimerRef.current);
  };
  const onUserScrollSettle = () => {
    if (suspendTimerRef.current) clearTimeout(suspendTimerRef.current);
    suspendTimerRef.current = setTimeout(() => {
      followSuspendedRef.current = false;
    }, 2000);
  };

  // Keyboard dismissal (interactive drag, Done, back button) always ends text mode.
  useEffect(() => {
    if (!editingId) return;
    const evt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const hide = Keyboard.addListener(evt, () => setEditingId(null));
    return () => hide.remove();
  }, [editingId]);

  const scrollToCue = useCallback((id: string, margin: number) => {
    const y = offsets.current.get(id);
    if (y != null) scrollRef.current?.scrollTo({ y: Math.max(0, y - margin), animated: true });
  }, []);

  // The row callbacks keep one identity across renders, so the memoized rows that aren't
  // playing skip the 10×/s playback re-renders.
  const selectCue = useCallback(
    (cue: Cue) => {
      setEditingId(null);
      setSelectedId(cue.id);
      player.pause();
      seekToRef.current(cue.t0 / 100);
      scrollToCue(cue.id, 96);
    },
    [player, scrollToCue],
  );

  const beginTextEdit = useCallback(
    (id: string) => {
      setEditingId(id);
      scrollToCue(id, Spacing.two);
    },
    [scrollToCue],
  );

  const endTextEdit = useCallback(() => {
    setEditingId(null);
    endCoalescing();
  }, [endCoalescing]);

  const clearSelection = () => {
    setSelectedId(null);
    setEditingId(null);
  };

  // Play is the "done" gesture: it drops the selection and resumes playback follow. No
  // end-of-clip restart logic needed — useParkedPlayback reparks the playhead at 0 on end.
  const togglePlay = () => {
    if (player.playing) {
      player.pause();
      return;
    }
    clearSelection();
    Keyboard.dismiss();
    player.play();
  };

  const onAddCue = () => {
    player.pause();
    const id = editor.addCueAt(posCs);
    setSelectedId(id);
    setEditingId(id); // a fresh cue is empty — jump straight to typing
  };

  const onSplit = () => {
    if (!selCue) return;
    armRowsReflow();
    const id = editor.splitAt(selCue.id, posCs);
    if (id) setSelectedId(id); // keep selection on the playhead's half
  };

  const [rowEdited, setRowEdited] = useState(savedJson != null);
  const showReset = (rowEdited || editor.dirty) && editor.cues.length > 0;
  // No confirm: the reset is undoable (see resetCuesRef), and the toast offers the Undo where
  // the eye already is.
  // The reset's Undo lives in this editor, so it can't outlive it: leaving the screen closes the
  // toast (the reset stands) rather than leaving an Undo up that would undo nothing.
  useEffect(() => () => closeResetToastRef.current?.(), []);
  const onResetToAuto = () => {
    clearSelection();
    const next = editor.resetTo(autoLines);
    resetCuesRef.current = next;
    setRowEdited(false);
    closeResetToastRef.current = showUndoToast({
      title: 'Captions reset',
      message: 'Back to the automatic captions',
      // Only while the reset is still the latest step — a later edit closes the toast (see the
      // effect above), and this guards the moment in between.
      onUndo: () => {
        if (cuesRef.current === next) undo();
      },
      // Already applied and persisted by the effect above; nothing is pending.
      onCommit: () => {},
    });
  };

  const selIndex = selCue ? editor.cues.indexOf(selCue) : -1;

  return (
    <ThemedView type="groupedBackground" style={styles.fill}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.header, { paddingTop: insets.top + Spacing.two }]}>
          <View
            style={[styles.headerTitleWrap, { top: insets.top + Spacing.two }]}
            pointerEvents="none">
            <ThemedText
              type="headline"
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              maxFontSizeMultiplier={1.3}>
              Captions
            </ThemedText>
          </View>
          <CloseButton onPress={() => router.back()} />
          <View style={styles.headerActions}>
            <HeaderBtn
              name="wand.and.stars"
              label="On-device AI model"
              hint="Choose the model used for captions"
              selected={!!selectedModel}
              valueText={selectedModel ? selectedModel.label : 'Off'}
              disabled={false}
              onPress={() => router.push('/on-device-ai')}
            />
            <HeaderBtn
              name="arrow.uturn.backward"
              label="Undo"
              disabled={!editor.canUndo}
              onPress={editor.undo}
            />
            <HeaderBtn
              name="arrow.uturn.forward"
              label="Redo"
              disabled={!editor.canRedo}
              onPress={editor.redo}
            />
          </View>
        </View>

        {/* The 4pt vertical margin snaps with the mode; only the width eases (`previewWidth`). */}
        <Animated.View
          style={[
            styles.previewCard,
            mode === 'text' ? styles.previewCardCompact : styles.previewCardFull,
            previewWidth,
          ]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={togglePlay}
            accessibilityRole="button"
            accessibilityLabel="Toggle playback">
            <VideoView
              style={StyleSheet.absoluteFill}
              player={player}
              contentFit="contain"
              nativeControls={false}
              // Android: the default SurfaceView ignores the card's rounded clipping (and this
              // card is resized every frame of the text-mode ease). A TextureView clips and
              // resizes like any view — the same as the recorder's preview.
              surfaceType="textureView"
            />
            <Animated.View
              style={[
                styles.previewLayer,
                { width: layerWidth, height: (layerWidth * 16) / 9 },
                layerScale,
              ]}
              pointerEvents="none">
              <CaptionOverlay lines={lines} positionMs={posCs * 10} />
              {!isPlaying && (
                <Animated.View
                  style={styles.playOverlay}
                  entering={BADGE_ENTER}
                  exiting={BADGE_EXIT}>
                  <GlassPill style={styles.playBadge}>
                    <Icon name="play.fill" size={22} tintColor="#fff" />
                  </GlassPill>
                </Animated.View>
              )}
            </Animated.View>
          </Pressable>
        </Animated.View>

        {/* Fades in only. No exit fade: on timing → text the toolbar would linger over the list
            as it moves up into its place, a ghost strip over the rows. */}
        {mode === 'timing' && selCue && (
          <Animated.View entering={TOOLBAR_ENTER}>
            <CueToolbar
              cue={selCue}
              posCs={posCs}
              theme={theme}
              canMerge={selIndex >= 0 && selIndex < editor.cues.length - 1}
              onSplit={onSplit}
              onMerge={() => {
                armRowsReflow();
                editor.mergeNext(selCue.id);
              }}
              onDelete={() => {
                armRowsReflow();
                editor.remove(selCue.id);
                clearSelection();
              }}
            />
          </Animated.View>
        )}

        <Animated.View style={styles.list} layout={reflowList ? LIST_REFLOW : undefined}>
          <ScrollView
            ref={scrollRef}
            style={styles.list}
            contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 96 }]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            onScrollBeginDrag={onUserScrollStart}
            onScrollEndDrag={onUserScrollSettle}
            onMomentumScrollEnd={onUserScrollSettle}>
            {editor.cues.length === 0 && (
              <ThemedText themeColor="textSecondary" style={styles.empty}>
                No captions yet. Add one at the playhead to start.
              </ThemedText>
            )}
            {editor.cues.map((cue) => (
              <Animated.View
                key={cue.id}
                layout={rowsReflow ? LIST_REFLOW : undefined}
                exiting={rowsReflow ? ROW_EXIT : undefined}
                onLayout={(e: LayoutChangeEvent) =>
                  offsets.current.set(cue.id, e.nativeEvent.layout.y)
                }>
                <CueRow
                  cue={cue}
                  state={
                    cue.id === editingId ? 'editing' : cue.id === selectedId ? 'selected' : 'view'
                  }
                  playing={cue.id === playingId}
                  // Only the playing row reads the playhead; the rest keep a constant 0 and skip
                  // the playback re-renders (CueRow is memoized).
                  posCs={cue.id === playingId ? posCs : 0}
                  theme={theme}
                  onSelect={selectCue}
                  onBeginTextEdit={beginTextEdit}
                  onChangeText={setText}
                  onEndTextEdit={endTextEdit}
                />
              </Animated.View>
            ))}
            {showReset && (
              <Pressable
                onPress={onResetToAuto}
                accessibilityRole="button"
                style={({ pressed }) => [styles.resetLink, pressed && styles.pressedLink]}>
                <ThemedText type="footnote" themeColor="textSecondary">
                  Reset to automatic captions
                </ThemedText>
              </Pressable>
            )}
          </ScrollView>
        </Animated.View>

        {mode === 'browse' && (
          <Animated.View
            entering={FOOTER_ENTER}
            exiting={FOOTER_EXIT}
            style={[styles.footer, { paddingBottom: insets.bottom + Spacing.two }]}>
            <PrimaryButton
              variant="card"
              label="Add caption"
              icon="plus"
              onPress={onAddCue}
              style={styles.footerBtn}
            />
          </Animated.View>
        )}
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

/** The preview's width, in % of the screen: browsing, and text mode (keyboard up). */
const PREVIEW_FULL = 56;
const PREVIEW_COMPACT = 36;

/** The list's glide when the toolbar docks or the footer leaves (see `reflowList`), and the
 * rows' when one is deleted, split or merged (see `rowsReflow`). */
const LIST_REFLOW = LinearTransition.duration(ListReflowMs).easing(EaseOut);
// Opacity-only fades, so they play under Reduce Motion too (nothing moves).
const ROW_EXIT = FadeOut.duration(150).easing(EaseOut).reduceMotion(ReduceMotion.Never);
const TOOLBAR_ENTER = FadeIn.duration(150).easing(EaseOut).reduceMotion(ReduceMotion.Never);
const FOOTER_ENTER = TOOLBAR_ENTER;
const FOOTER_EXIT = FadeOut.duration(120).easing(EaseOut).reduceMotion(ReduceMotion.Never);
// The ▶ badge zooms (like the recorder preview's): scale only, never an opacity on the glass.
const BADGE_ENTER = ZoomIn.duration(150);
const BADGE_EXIT = ZoomOut.duration(150);

// The header's right-hand cluster: three 40pt buttons, 8pt apart.
const HEADER_BTN = 40;
const HEADER_ACTIONS_WIDTH = HEADER_BTN * 3 + Spacing.two * 2;

function HeaderBtn({
  name,
  label,
  hint,
  selected,
  valueText,
  disabled,
  onPress,
}: {
  name: IconName;
  label: string;
  /** Optional a11y hint (e.g. what picking the button leads to). */
  hint?: string;
  /** Optional a11y selection state (e.g. "a model is active"). */
  selected?: boolean;
  /** Optional a11y value announced after the label (e.g. the active model's name, or "Off"). */
  valueText?: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const mode = useThemeMode();
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={selected != null ? { disabled, selected } : { disabled }}
      accessibilityValue={valueText != null ? { text: valueText } : undefined}
      style={({ pressed }) => [
        styles.headerBtn,
        ControlScrim[mode],
        // "On" fills the circle with the accent and keeps the glyph white: a red glyph on the
        // grey scrim was ~1.3:1 in light mode, barely readable.
        selected && { backgroundColor: theme.accent, borderColor: 'transparent' },
        disabled && styles.headerBtnDisabled,
        pressed && styles.pressed,
      ]}>
      <Icon name={name} size={20} weight="semibold" tintColor="#fff" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  centerAll: { alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  stateWrap: { alignSelf: 'stretch', paddingHorizontal: Spacing.three },
  pressed: { opacity: Opacity.pressed },
  pressedLink: { opacity: Opacity.pressedGlyph },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
  },
  // Inset past the wider (right-hand) button cluster on BOTH sides, so the title stays centred
  // and can never run under the ✕ or the buttons; it shrinks to fit instead (adjustsFontSizeToFit).
  headerTitleWrap: {
    position: 'absolute',
    left: Spacing.three + HEADER_ACTIONS_WIDTH,
    right: Spacing.three + HEADER_ACTIONS_WIDTH,
    bottom: Spacing.two,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerActions: { flexDirection: 'row', gap: Spacing.two },
  // Same 40pt scrim circle as the ✕ beside it (and export's captions button), so the header
  // reads as one set.
  headerBtn: {
    width: HEADER_BTN,
    height: HEADER_BTN,
    borderRadius: HEADER_BTN / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerBtnDisabled: { opacity: Opacity.disabled },
  // Width is animated (`previewWidth`): 56% browsing, 36% in text mode.
  previewCard: {
    aspectRatio: 9 / 16,
    overflow: 'hidden',
    borderRadius: Radius.row,
    borderCurve: 'continuous',
    backgroundColor: '#000',
    alignSelf: 'center',
  },
  previewCardFull: { marginVertical: Spacing.two },
  previewCardCompact: { marginVertical: Spacing.one },
  // Sized inline to the full preview and scaled from its top-left corner (`layerScale`), so it
  // always covers the card exactly.
  previewLayer: { position: 'absolute', left: 0, top: 0, transformOrigin: 'top left' },
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
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 3,
  },
  list: { flex: 1 },
  listContent: { padding: Spacing.three },
  empty: { textAlign: 'center', marginTop: Spacing.five },
  resetLink: { alignItems: 'center', paddingVertical: Spacing.three },
  footer: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.two,
  },
  footerBtn: { flex: 1 },
});
