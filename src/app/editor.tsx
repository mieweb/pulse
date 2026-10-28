import { PulsePreview } from '@mieweb/pulse-editor';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BackHandler,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ExportButton } from '@/components/export-button';
import { Icon } from '@/components/icon';
import Sortable from 'react-native-sortables';

import { CaptionStatus, CaptionTools } from '@/features/editor/caption-tools';
import { ClipRow } from '@/features/editor/clip-row';
import { HeaderButton, ViewSwitcher } from '@/features/editor/editor-controls';
import { useFrameRates } from '@/features/editor/use-frame-rates';
import { flushDraftWrites } from '@/features/editor/draft-writes';
import {
  CaptionTextBar,
  ClipToolbar,
  MainToolbar,
  SpeedRow,
  TOOLBAR_HEIGHT,
} from '@/features/editor/clip-toolbar';
import { CropEditor } from '@/features/editor/crop-editor';
import { SkiaCaption } from '@/features/transcription/skia-caption';
import {
  resetTimelineZoom,
  STRIP_HEIGHT,
  TimelineStrip,
  type TrimInfo,
  type TrimSide,
} from '@/features/editor/timeline-strip';
import {
  captionZoom,
  clamp,
  clipIndexAt,
  clipZoom,
  draftZoom,
  type ZoomRequest,
  flippedEdit,
  formatTime,
  rotated,
  timelineLayout,
} from '@/features/editor/timeline-geometry';
import { captionYQuery, setCaptionY } from '@/db/captions';
import { allSegments } from '@/db/drafts';
import { pruneFrameCache } from '@/features/editor/filmstrip';
import { toMergeClip } from '@/features/export/editor-merge';
import { getEditorView, setEditorView, type EditorView } from '@/db/settings';
import { useEditorDraft, type EditorClip } from '@/features/editor/use-editor-draft';
import { useEditorHistory } from '@/features/editor/use-editor-history';
import { usePlayheadClip } from '@/features/editor/use-playhead-clip';
import { usePreviewTransport } from '@/features/editor/use-preview-transport';
import { useWaveforms } from '@/features/editor/use-waveforms';
import { loadCustomSpeeds, speedMenu } from '@/features/editor/editor-speeds';
import { TipAnchor } from '@/features/tips/tip-anchor';
import { TipLayer } from '@/features/tips/tip-callout';
import { useTip } from '@/features/tips/use-tip';
import { useToast } from '@/features/toast/toast-provider';
import { captionStyleFor } from '@/features/transcription/caption-style';
import {
  mergeWithNext,
  removeWord,
  replaceWordText,
  seedStarts,
  setTimes,
  splitAt,
  type CaptionWord,
} from '@/features/transcription/caption-edits';
import {
  clipSpans,
  clipWords,
  lineAt,
  timelineCs,
  toFileCs,
  wordGripLimits,
} from '@/features/transcription/compose';
import { useDraftCaptions } from '@/features/transcription/use-draft-captions';
import { useTheme } from '@/hooks/use-theme';
import { haptics } from '@/utils/haptics';
import { clipRender, type ClipCrop, type ParsedEdit } from '@/utils/segment-window';

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

/** Back to the recorder (or Home, when the editor was opened by a link). */
const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

/**
 * The timeline editor: the draft playing as it will export (<PulsePreview>), a strip of its
 * clips under a centre playhead, and a bottom bar of tools. Every edit applies at once (no Save),
 * with undo/redo in the header; trims snap to source frames as the engine does.
 *
 * The bottom bar's main tools open a mode until its ✓. Edit (or a tap on a clip) edits the clip
 * under the playhead, and moving the playhead onto another clip moves the selection with it
 * (nothing is selected on open). Captions picks and downloads a model (every clip is then
 * transcribed in the background); a tapped word is edited or deleted, and sentences are split or
 * merged at the playhead. Captions show over the preview (drag one to move them all) and on a
 * lane under the clips; their edits are kept per clip, so trims and reorders carry them along.
 */
export default function EditorScreen() {
  // Not compiled by the React Compiler (as before): its memoization here leaves the track's
  // animated opacity stale until a re-render. To be turned on as a change of its own, tested.
  'use no memo';
  const params = useLocalSearchParams<{ draftId: string; clipId?: string; view?: string }>();
  const { draftId, clipId } = params;
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const draft = useEditorDraft(draftId);
  const { clips, covers, options } = draft;
  const { ctl, values, playing, status } = usePreviewTransport();
  const history = useEditorHistory(
    clips,
    draft.setValue,
    draft.reorder,
    draft.captionEdits,
    draft.setCaptions,
  );
  const { data: captionRows } = useLiveQuery(captionYQuery(draftId), [draftId]);
  const captionYValue = captionRows[0]?.captionY;
  // The same object until the place changes, so the caption on the video doesn't re-render.
  const captionStyle = useMemo(() => captionStyleFor(captionYValue), [captionYValue]);
  const { showToast } = useToast();
  const fpsOf = useFrameRates(clips.map((c) => c.uri));
  const peaks = useWaveforms(
    clips.map((c) => c.uri),
    !!status?.ready,
  );

  // Clips (thumbnails, for picking and reordering) or Timeline (lengths, scrub, trim): the one
  // last switched to, remembered across sessions (Clips the first time).
  const [view, setView] = useState<EditorView>(
    () => getEditorView() ?? (params.view === 'timeline' ? 'timeline' : 'clips'),
  );
  const [tools, setTools] = useState<'clip' | 'speed'>('clip');
  // Each editor opens the timeline at its usual scale (a pinch's scale is kept across views).
  useState(resetTimelineZoom);
  // The bottom bar: the main tools, edit mode (the tools of the clip under the playhead) or the
  // captions tools (for the caption under it). Always the main tools on open (a clip tapped in the
  // recorder opens paused on it, nothing selected).
  const [mode, setMode] = useState<'main' | 'edit' | 'captions'>('main');
  const captionTools = mode === 'captions';
  // The word being typed (its clip and index in the clip's words), and its text as it was.
  const [typing, setTyping] = useState<{ clipId: string; i: number; text: string } | null>(null);
  // A scale for the timeline to zoom to (opening, a caption or a clip to edit), and how to ask.
  const [zoomTo, setZoomTo] = useState<(ZoomRequest & { seq: number }) | null>(null);
  const requestZoom = (req: ZoomRequest) => setZoomTo((z) => ({ ...req, seq: (z?.seq ?? 0) + 1 }));
  const [cropping, setCropping] = useState<{ id: string; timeMs: number } | null>(null);
  const [trimmingId, setTrimmingId] = useState<string | null>(null);
  const [customSpeeds, setCustomSpeeds] = useState<readonly number[]>([]);
  // The preview area, and the picture fitted in it at the canvas's aspect: the player is sized to
  // the picture, so what's around it is the theme's background (not the player's black bars).
  const [stage, setStage] = useState({ w: 0, h: 0 });
  useEffect(() => {
    void loadCustomSpeeds().then(setCustomSpeeds);
  }, []);

  // The preview's clips: the draft's, with the clip being trimmed played whole so the handle can
  // show frames past the current trim. Stable while those don't change (a new array rebuilds).
  const previewClips = useMemo(
    () => clips.map((c) => (c.id === trimmingId ? { ...c.merge, startMs: 0, endMs: 0 } : c.merge)),
    [clips, trimmingId],
  );

  // The engine reports after each rebuild, so a status describes the clips the preview had when
  // it came in. Once they change, it's the old clips' until the rebuild reports: lengths alone
  // can't tell (a one-frame trim moves a clip by less than the layout's tolerance).
  const [statusOf, setStatusOf] = useState({ status, clips: previewClips });
  if (statusOf.status !== status) setStatusOf({ status, clips: previewClips });
  const builtStatus = statusOf.clips === previewClips ? status : null;

  // Positions come from the engine once its status describes these clips (see timelineLayout).
  const layout = useMemo(
    () =>
      timelineLayout(
        clips.map((c) => c.lengthMs),
        builtStatus,
      ),
    [clips, builtStatus],
  );
  // The playhead's range is the layout's, known as soon as the clips are (before the preview is up).
  useLayoutEffect(() => ctl.setTotal(layout.totalMs), [ctl, layout.totalMs]);
  // Captions at the clips' places on this timeline (the preview's), so they sit on the waveform.
  const captions = useDraftCaptions(draftId, draft.segments, layout);

  // In edit mode the clip being edited is the one under the playhead: scrubbing, flinging or
  // playing onto another clip moves the selection (and its red frame) with it.
  const current = usePlayheadClip(layout.starts, values.timeMs, mode === 'edit');
  if (current < 0 && tools !== 'clip') setTools('clip');

  // Android back leaves crop, typing, the speed row or a mode first, then the editor (only while
  // the editor is on screen: a screen pushed over it handles its own back).
  useFocusEffect(
    useCallback(() => {
      if (!cropping && !typing && tools === 'clip' && mode === 'main') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (cropping) setCropping(null);
        else if (typing) setTyping(null);
        else if (tools !== 'clip') setTools('clip');
        else setMode('main');
        return true;
      });
      return () => sub.remove();
    }, [cropping, typing, tools, mode]),
  );

  // Once per app run: the filmstrip's disk cache keeps only frames of files a clip still plays.
  useEffect(() => {
    allSegments()
      .then((rows) => pruneFrameCache(rows.map((s) => toMergeClip(s).uri)))
      .catch(() => {});
  }, []);

  // Leave when the draft has no clips left.
  useEffect(() => {
    if (draft.loaded && clips.length === 0) close();
  }, [draft.loaded, clips.length]);

  // Opened on a clip: the playhead starts on it. Placed once the clips are known, before the strip
  // or row is shown (they stay hidden until then, on the UI thread, so no frame shows 0 first).
  const placed = useSharedValue(clipId ? 0 : 1);
  const placedOnce = useRef(!clipId);
  useLayoutEffect(() => {
    if (placedOnce.current || clips.length === 0) return;
    placedOnce.current = true;
    const i = clips.findIndex((c) => c.id === clipId);
    // Opened from a clip in the recorder: paused at that clip's start.
    ctl.place(i > 0 ? (layout.starts[i] ?? 0) : 0);
    placed.set(1);
  }, [clips, clipId, ctl, layout.starts, placed]);
  // The scale the timeline opens at, once the clips are known: the clip it was opened on fitted
  // (`clipZoom`, ready to trim), or the whole draft when it's short (`draftZoom`).
  const openedZoom = useRef(false);
  useLayoutEffect(() => {
    if (openedZoom.current || clips.length === 0 || layout.totalMs <= 0) return;
    openedZoom.current = true;
    const w = Dimensions.get('window').width;
    const c = clipId ? clips.find((x) => x.id === clipId) : undefined;
    const target = c
      ? clipZoom(c.lengthMs, layout.totalMs, w).target
      : draftZoom(layout.totalMs, w);
    requestZoom({ min: target, max: target, target, instant: true });
  }, [clips, clipId, layout.totalMs]);
  const trackStyle = useAnimatedStyle(() => ({ opacity: placed.get() }));
  const coverStyle = useAnimatedStyle(() => ({ opacity: values.covered.get() }));

  /** Off-clip space was tapped: edit mode ends, or the selected caption word is let go (the
   * captions tools stay until ✓). */
  const deselect = () => {
    if (mode === 'edit') setMode('main');
    else if (captionTools) setPicked(null);
  };
  /** A reorder let go: store the new order (clip ids, slot by slot) if it changed; edit mode, on
   * the moved clip at its new place (the playhead just inside its start, so a slightly different
   * start from the engine still finds it there). */
  const commitOrder = (ids: string[], held: string) => {
    if (ids.length !== clips.length || ids.every((id, i) => id === clips[i].id)) return;
    haptics.drop();
    history.record(null);
    draft.reorder(ids);
    setMode('edit');
    let at = 0;
    for (const id of ids) {
      if (id === held) break;
      at += clips.find((c) => c.id === id)?.lengthMs ?? 0;
    }
    const heldMs = clips.find((c) => c.id === held)?.lengthMs ?? 0;
    ctl.seekTo(at + Math.min(100, heldMs / 2));
  };

  /** A tap on a clip (either view): edit mode, on that clip. The playhead moves onto it if it
   * isn't there (to where the tap was on the timeline, to its start in the row). */
  const tapClip = (i: number, ms?: number) => {
    const c = clips[i];
    if (!c) {
      deselect();
      return;
    }
    haptics.tap();
    setTyping(null);
    setMode('edit');
    zoomToClip(i);
    if (i !== clipIndexAt(layout.starts, ctl.lastMs)) ctl.seekTo(ms ?? layout.starts[i] ?? 0);
  };

  const slotOf = (i: number) => {
    const start = layout.starts[i] ?? 0;
    const end = i + 1 < layout.starts.length ? layout.starts[i + 1] : layout.totalMs;
    return { start, end };
  };

  /** The clip the tools act on: the one under the playhead, in edit mode. */
  const target = (): { clip: EditorClip; index: number } | null =>
    current >= 0 ? { clip: clips[current], index: current } : null;

  // A change to a clip's length (speed, Reset, undo/redo) moves every later clip, so the playhead
  // would land in another one (and edit mode with it). It stays in the clip it was in, on the same
  // moment of its source, placed once the new layout is known (as a trim's end is).
  const keepOn = useRef<{ id: string; sourceMs: number; until: number } | null>(null);
  const keepPlayhead = () => {
    const t = target();
    if (!t) return;
    const { start } = slotOf(t.index);
    const e = t.clip.edit;
    keepOn.current = {
      id: t.clip.id,
      sourceMs: e.startMs + Math.max(0, ctl.lastMs - start) * e.speed,
      // The change shows on the next render; one that changed no clip (a caption undo) lapses.
      until: Date.now() + 1000,
    };
  };
  useEffect(() => {
    const k = keepOn.current;
    keepOn.current = null;
    if (!k || Date.now() > k.until) return;
    const i = clips.findIndex((c) => c.id === k.id);
    if (i < 0) return;
    const c = clips[i];
    const start = layout.starts[i] ?? 0;
    const end = i + 1 < layout.starts.length ? layout.starts[i + 1] : layout.totalMs;
    const frameMs = 1000 / (fpsOf(c.uri) ?? 30);
    const at =
      start + (clamp(k.sourceMs, c.edit.startMs, c.edit.endMs) - c.edit.startMs) / c.edit.speed;
    ctl.endTrim(clamp(at, start, Math.max(start, end - frameMs)));
    // Only a change of the clips places it (the layout follows them).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);

  const edit = (opKey: string | null, change: (e: ParsedEdit) => ParsedEdit) => {
    const t = target();
    if (!t || !t.clip.editable) return;
    haptics.tap();
    history.record(opKey && `${opKey}:${t.clip.id}`);
    const next = change(t.clip.edit);
    if (next.speed !== t.clip.edit.speed) keepPlayhead();
    draft.setEdit(t.clip.id, next);
  };

  const onTap = (ms: number) => {
    if (ms < 0 || ms > layout.totalMs) {
      deselect();
      return;
    }
    tapClip(clipIndexAt(layout.starts, ms), ms);
  };

  const sel = current >= 0 ? clips[current] : null;
  const selFps = sel ? fpsOf(sel.uri) : null;
  const trim: TrimInfo | null =
    sel?.editable && selFps
      ? {
          startMs: sel.edit.startMs,
          endMs: sel.edit.endMs,
          sourceMs: sel.sourceMs,
          speed: sel.edit.speed,
          slotStartMs: slotOf(current).start,
          frameMs: 1000 / selFps,
        }
      : null;

  // The clip whose grip was grabbed, and its trim then: the release applies to it even if the
  // clip under the playhead changed meanwhile.
  const trimmed = useRef<{ clip: EditorClip; trim: TrimInfo } | null>(null);
  const onTrimStart = () => {
    if (!sel || !trim) return;
    haptics.pickUp();
    trimmed.current = { clip: sel, trim };
    setTrimmingId(sel.id);
    ctl.beginDrag();
  };

  const onTrimEnd = (side: TrimSide, ms: number) => {
    setTrimmingId(null);
    const grabbed = trimmed.current;
    trimmed.current = null;
    const sel = grabbed ? clips.find((c) => c.id === grabbed.clip.id) : undefined;
    const trim = grabbed?.trim;
    if (!sel || !trim || !sel.editable) {
      ctl.endScrub(ctl.lastMs);
      return { leftMs: 0, lengthMs: 0 };
    }
    const e = sel.edit;
    const next = side === 1 ? { ...e, startMs: Math.round(ms) } : { ...e, endMs: Math.round(ms) };
    if (next.startMs !== e.startMs || next.endMs !== e.endMs) {
      history.record(`trim:${sel.id}`);
      history.close();
      draft.setEdit(sel.id, next);
    }
    const lengthMs = (next.endMs - next.startMs) / next.speed;
    const start = trim.slotStartMs;
    // The playhead goes to the new start, or to the last frame before the new end.
    ctl.endTrim(side === 1 ? start : Math.max(start, start + lengthMs - trim.frameMs / next.speed));
    return { leftMs: start, lengthMs };
  };

  const startCrop = () => {
    const t = target();
    if (!t || !t.clip.editable) return;
    ctl.pause();
    haptics.tap();
    const { start } = slotOf(t.index);
    const e = t.clip.edit;
    const at =
      ctl.lastMs >= start && ctl.lastMs < slotOf(t.index).end
        ? e.startMs + (ctl.lastMs - start) * e.speed
        : e.startMs;
    setCropping({ id: t.clip.id, timeMs: clamp(at, e.startMs, Math.max(e.startMs, e.endMs - 1)) });
  };

  const finishCrop = (crop: ClipCrop | null) => {
    const c = clips.find((x) => x.id === cropping?.id);
    setCropping(null);
    if (!c) return;
    const same = JSON.stringify(crop) === JSON.stringify(c.edit.crop);
    if (same) return;
    history.record(null);
    draft.setEdit(c.id, { ...c.edit, crop });
  };

  /** Delete the clip under the playhead (edit mode stays, on the clip that comes there next: the
   * playhead goes to the deleted clip's start). One at a time: a second tap while one is going
   * would delete the clip that's under the playhead for a moment, not the next. */
  const deleting = useRef<string | null>(null);
  useEffect(() => {
    if (deleting.current && !clips.some((c) => c.id === deleting.current)) deleting.current = null;
  }, [clips]);
  const remove = () => {
    const t = target();
    if (!t || deleting.current) return;
    haptics.drop();
    deleting.current = t.clip.id;
    const { start } = slotOf(t.index);
    ctl.seekTo(start);
    void draft.remove(t.clip.id).finally(() => {
      if (clips.some((c) => c.id === t.clip.id)) deleting.current = null; // it failed
    });
  };

  // Export reads the stored clips: it opens once every edit asked for is stored (a cover renders
  // first, up to about half a second), and once per tap until the editor is back on screen.
  const exporting = useRef(false);
  useFocusEffect(
    useCallback(() => {
      exporting.current = false;
    }, []),
  );
  const openExport = () => {
    if (exporting.current) return;
    exporting.current = true;
    ctl.pause();
    void flushDraftWrites().then(() => router.push({ pathname: '/export', params: { draftId } }));
  };

  const reset = () => {
    const t = target();
    if (!t) return;
    haptics.tap();
    // A legacy baked edit can't come back once its file is gone: like delete, no undo step.
    if (t.clip.editable) history.record(null);
    keepPlayhead();
    draft.setValue(t.clip.id, null);
  };

  // --- Captions ---------------------------------------------------------------------------
  // Captions with no model opens the model picker; once one is picked, the captions tools open
  // and its download starts here (the person asked for captions).
  const wantCaptions = useRef(false);
  const captionStatus = captions.state.status;
  const { download: downloadCaptionsModel } = captions;
  useEffect(() => {
    if (!wantCaptions.current || captionStatus === 'no-model') return;
    wantCaptions.current = false;
    if (captionStatus === 'needs-download') downloadCaptionsModel();
    setMode('captions');
  }, [captionStatus, downloadCaptionsModel]);

  const captionsTip = useTip(
    'captions',
    draft.loaded && clips.length > 0 && mode === 'main' && captionStatus === 'no-model',
    { delayMs: 800 },
  );

  const openCaptions = () => {
    haptics.tap();
    captionsTip.retire();
    if (captionStatus === 'no-model') {
      wantCaptions.current = true;
      router.push('/on-device-ai');
      return;
    }
    if (captionStatus === 'needs-download') captions.download();
    setMode('captions');
    setPicked(null);
    // The sentence under the playhead (or the next one) at a scale its words can be edited at.
    const pos = values.timeMs.get() / 10;
    const at = lineAt(captions.lines, pos);
    zoomToCaption(at >= 0 ? at : captions.lines.findIndex((l) => l.t0 > pos));
  };

  // Editing captions: the timeline (where the captions lane is), zoomed so the sentence's words
  // can be read and grabbed (`captionZoom`).
  const zoomToCaption = (i: number, word = -1) => {
    const line = captions.lines[i];
    if (!line?.words?.length) return;
    if (view !== 'timeline') setView('timeline');
    requestZoom(captionZoom(line.words, Dimensions.get('window').width, word));
  };
  /** Editing clip `i` on the timeline: zoomed so the whole clip and its grips are in view. */
  const zoomToClip = (i: number) => {
    const c = clips[i];
    if (!c || view !== 'timeline') return;
    requestZoom(clipZoom(c.lengthMs, layout.totalMs, Dimensions.get('window').width));
  };

  // --- Caption selection and editing (the lane) ---------------------------------------
  const lines = captions.lines;
  // A word is selected by tapping it (on the lane or on the video), and stays selected while the
  // playhead moves or plays, until another is tapped, the lane's or the screen's empty space is,
  // or it's deleted. Edit and Delete act on it (off until one is tapped); Split and Merge act at
  // the playhead (`CaptionTools`).
  /** The selected word (clip id and index in the clip's words), while the captions tools are
   * open. */
  const [picked, setPicked] = useState<{ clipId: string; i: number } | null>(null);
  /** The selected word's sentence (its index in `lines`), and the word's index in its words. */
  const selLine =
    captionTools && picked
      ? lines.findIndex((l) => l.clipId === picked.clipId && picked.i >= l.from && picked.i < l.to)
      : -1;
  const selWord = selLine >= 0 && picked ? picked.i - lines[selLine].from : -1;
  // A selection (and typing) is an index in the clip's words: once the words are others (undo,
  // redo, Reset, another model), it's let go rather than moved onto another word.
  const letGo = () => {
    setPicked(null);
    setTyping(null);
  };
  const modelId = captions.model?.id ?? null;
  const [pickedModel, setPickedModel] = useState(modelId);
  if (pickedModel !== modelId) {
    setPickedModel(modelId);
    letGo();
  }
  const undo = () => {
    letGo();
    keepPlayhead();
    history.undo();
  };
  const redo = () => {
    letGo();
    keepPlayhead();
    history.redo();
  };

  /** A tap on a caption selects the word tapped and moves the playhead to its start (in a gap:
   * lets the selection go, the playhead to where it was tapped). On the lane (`toggle`), a tap on
   * the selected word lets it go. */
  const onCaptionTap = (ms: number, toggle = false) => {
    setTyping(null);
    if (!captionTools) setMode('captions');
    ctl.pause();
    const i = lineAt(lines, ms / 10);
    if (i < 0) {
      setPicked(null);
      ctl.seekTo(ms);
      return;
    }
    haptics.tap();
    const ws = lines[i].words ?? [];
    let k = 0;
    for (let j = 0; j < ws.length; j++) if (ms / 10 >= ws[j].t0) k = j;
    zoomToCaption(i, k);
    const again = toggle && selLine === i && selWord === k;
    setPicked(again ? null : { clipId: lines[i].clipId, i: lines[i].from + k });
    ctl.seekTo((ws[k] ?? lines[i]).t0 * 10);
  };

  const segmentOf = (id: string) => draft.segments.find((s) => s.id === id);
  /** A clip's caption words as they are now (its edit, else the model's with the sentences shown
   * marked, so the first edit keeps them). */
  const wordsOf = (clipId: string): CaptionWord[] => {
    const seg = segmentOf(clipId);
    const own = seg && clipWords(seg, captions.clipRows);
    if (!own) return [];
    const shown = lines.filter((l) => l.clipId === clipId);
    return seedStarts(
      own.words,
      shown.map((l) => l.from),
      shown.length ? shown[shown.length - 1].to : 0,
    );
  };
  /** Store a clip's caption words, in the file it plays (one undo step). */
  const saveCaptionWords = (clipId: string, words: CaptionWord[]) => {
    const seg = segmentOf(clipId);
    if (!seg) return;
    history.record(null);
    draft.setCaptions(new Map([[clipId, JSON.stringify({ file: clipRender(seg).file, words })]]));
  };

  // What the selected word's grips may do (timeline ms): its box and how far each edge can go
  // (each edge moves only its own word).
  const spans = clipSpans(draft.segments, layout);
  const captionDrag = wordGripLimits(lines, selLine, selWord, spans);

  /** A selected word's grip let go: `side` 1 its start, 2 its end, at timeline `ms` (that word
   * only). Saved in the clip's file time, one undo step. */
  const onCaptionDragEnd = (side: number, ms: number) => {
    const line = selLine >= 0 ? lines[selLine] : null;
    const span = line ? spans.get(line.clipId) : undefined;
    if (!line || !span || !captionDrag) {
      ctl.endScrub(ctl.lastMs);
      return;
    }
    // The word's edges as they'll be drawn (timeline ms): saved (if moved) and mapped back as the
    // captions are, so the playhead lands inside the word.
    let t0 = captionDrag.box.t0;
    let t1 = captionDrag.box.t1;
    if (Math.abs(ms - (side === 1 ? t0 : t1)) >= 1) {
      const i = line.from + selWord;
      const cs = toFileCs(span, ms);
      const words = setTimes(wordsOf(line.clipId), i, side === 1 ? { t0: cs } : { t1: cs });
      haptics.drop();
      saveCaptionWords(line.clipId, words);
      t0 = timelineCs(span, words[i].t0) * 10;
      t1 = timelineCs(span, words[i].t1) * 10;
    }
    // The preview and the playhead on the edge that was moved (for its end, a hair inside, so a
    // word that starts right there isn't the one under it).
    ctl.endScrub(side === 1 ? t0 : Math.max(t0, t1 - 1));
  };

  const editCaption = () => {
    if (selLine < 0) return;
    ctl.pause();
    const line = lines[selLine];
    const w = line.words?.[selWord];
    setTyping({ clipId: line.clipId, i: line.from + selWord, text: w?.text ?? '' });
  };
  const deleteCaption = () => {
    if (selLine < 0) return;
    haptics.tap();
    const line = lines[selLine];
    setPicked(null);
    saveCaptionWords(line.clipId, removeWord(wordsOf(line.clipId), line.from + selWord));
  };
  /** A new sentence from word `i` of the clip's words on. */
  const splitCaption = (clipId: string, i: number) => {
    haptics.tap();
    saveCaptionWords(clipId, splitAt(wordsOf(clipId), i));
  };
  /** The sentence ending before word `to` of the clip's words joined with the next. */
  const mergeCaption = (clipId: string, to: number) => {
    haptics.tap();
    saveCaptionWords(clipId, mergeWithNext(wordsOf(clipId), to));
  };
  const captionsEdited = [...draft.captionEdits.values()].some((v) => v != null);
  const resetCaptions = () => {
    const edited = [...draft.captionEdits].filter(([, v]) => v != null);
    if (!edited.length) return;
    haptics.tap();
    letGo();
    history.record(null);
    draft.setCaptions(new Map(edited.map(([id]) => [id, null])));
  };
  const moveCaptions = (y: number) =>
    setCaptionY(draftId, y).catch((e: unknown) => {
      showToast({ kind: 'error', title: 'Couldn’t move the captions', message: 'Try again.' });
      throw e;
    });

  /** Typing done: the word's new text (several words if typed as several; none deletes it). */
  const finishTyping = (text: string) => {
    const t = typing;
    setTyping(null);
    if (!t) return;
    const clean = text.trim();
    // Emptied: the word is gone, and so is the selection.
    if (!clean) setPicked(null);
    if (clean !== t.text)
      saveCaptionWords(t.clipId, replaceWordText(wordsOf(t.clipId), t.i, clean));
  };

  const { timeMs } = values;
  const timeProps = useAnimatedProps(() => {
    const text = formatTime(timeMs.get());
    return { text, defaultValue: text } as object;
  });

  const cropClip = cropping ? clips.find((c) => c.id === cropping.id) : null;
  const aspect = options ? options.width / options.height : 9 / 16;
  const fitW = Math.min(stage.w, stage.h * aspect);
  const picture = { width: fitW, height: fitW / aspect };
  const captionsBusy = captionStatus === 'downloading' || captionStatus === 'transcribing';
  // Created once the area is measured and the clips are known; dropped with no clips left.
  const showPreview = !!options && previewClips.length > 0 && fitW > 0;
  useEffect(() => {
    if (!showPreview) ctl.detach();
  }, [showPreview, ctl]);

  return (
    // The portal lifts a picked-up clip above everything (preview, controls) while it's dragged.
    <Sortable.PortalProvider>
      {/* Typing a caption lifts the strip and the text bar above the keyboard (the preview gives
          up the room). */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.root, { paddingTop: insets.top, backgroundColor: theme.background }]}>
        {/* Off-clip space, like every black area around the controls: a tap lets a selection go. */}
        <Pressable style={styles.header} onPress={deselect} accessible={false}>
          <HeaderButton icon="xmark" label="Close" onPress={close} />
          <View style={styles.headerRight}>
            <HeaderButton
              icon="arrow.uturn.backward"
              label="Undo"
              onPress={undo}
              disabled={!history.canUndo}
            />
            <HeaderButton
              icon="arrow.uturn.forward"
              label="Redo"
              onPress={redo}
              disabled={!history.canRedo}
            />
            {/* Finished editing: on to the export screen (back returns here). */}
            <View style={styles.export}>
              <ExportButton onPress={openExport} />
            </View>
          </View>
        </Pressable>

        <Pressable
          style={[styles.preview, { backgroundColor: theme.background }]}
          onLayout={(e) =>
            setStage({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
          }
          // Plays or pauses, in any mode (watch an edit without leaving edit mode).
          onPress={ctl.toggle}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}>
          {/* Created once the area is measured, at the picture's size. */}
          {showPreview && (
            <PulsePreview
              style={picture}
              clips={previewClips}
              options={options}
              onTime={ctl.onTime}
              onStatus={ctl.onStatus}
              onReady={ctl.onReady}
            />
          )}
          <Animated.View
            // Over the player (absolute, centred like it), not stacked under it.
            style={[styles.cover, picture, { backgroundColor: theme.background }, coverStyle]}
            pointerEvents="none"
          />
          {fitW > 0 && captions.lines.length > 0 && (
            <View style={[styles.cover, picture]} pointerEvents="box-none">
              <SkiaCaption
                lines={captions.lines}
                timeMs={values.timeMs}
                style={captionStyle}
                width={picture.width}
                height={picture.height}
                onPickUp={ctl.pause}
                onMove={moveCaptions}
                onTap={() => onCaptionTap(values.timeMs.get())}
              />
            </View>
          )}
          <CaptionStatus captions={captions} open={captionTools} />
          {status?.error && (
            <Text style={[styles.error, { color: theme.textSecondary }]}>{status.error}</Text>
          )}
        </Pressable>

        {/* Off-clip space: a tap here lets a selection go (play and the switcher keep their taps). */}
        <Pressable style={styles.transport} onPress={deselect} accessible={false}>
          <View style={styles.times} pointerEvents="none">
            <AnimatedTextInput
              editable={false}
              underlineColorAndroid="transparent"
              style={[styles.time, styles.timeNow, { color: theme.text }]}
              animatedProps={timeProps}
              defaultValue={formatTime(0)}
            />
            <Text style={[styles.time, { color: theme.textSecondary }]}>
              {' '}
              / {formatTime(layout.totalMs)}
            </Text>
          </View>
          <Pressable
            onPress={ctl.toggle}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={playing ? 'Pause' : 'Play'}
            style={styles.play}>
            <Icon name={playing ? 'pause.fill' : 'play.fill'} size={22} tintColor={theme.text} />
          </Pressable>
          <View style={styles.switchSlot}>
            <ViewSwitcher
              view={view}
              onChange={(v) => {
                setView(v);
                void setEditorView(v).catch(() => {});
              }}
            />
          </View>
        </Pressable>

        {/* One container for both views: hidden until the playhead is placed (its style stays on one
            view, never moved between two). */}
        <Animated.View style={[styles.track, trackStyle]}>
          {view === 'timeline' ? (
            <TimelineStrip
              clips={clips}
              covers={covers}
              peaks={peaks}
              layout={layout}
              selected={current}
              trim={trim}
              values={values}
              captions={captions.lines}
              captionSelected={selLine}
              captionWord={selWord}
              captionDrag={captionDrag}
              onCaptionTap={(ms) => onCaptionTap(ms, true)}
              onCaptionDragStart={() => {
                ctl.pause();
                ctl.beginDrag();
              }}
              onCaptionDragEnd={onCaptionDragEnd}
              zoomTo={zoomTo}
              onDragStart={ctl.beginDrag}
              onScrubEnd={ctl.endScrub}
              onTap={onTap}
              onTrimStart={onTrimStart}
              onTrimEnd={onTrimEnd}
            />
          ) : (
            <ClipRow
              clips={clips}
              covers={covers}
              layout={layout}
              selected={current}
              values={values}
              onSelect={(id) => tapClip(clips.findIndex((c) => c.id === id))}
              onDragStart={ctl.beginDrag}
              onScrubEnd={ctl.endScrub}
              onReorderStart={ctl.pause}
              onReorder={commitOrder}
              onBlankTap={deselect}
            />
          )}
        </Animated.View>

        <Pressable
          // One height whether it holds the tools or the hint, so selecting never moves the layout.
          // Above the keyboard while typing, it needs no room for the home indicator.
          style={[
            styles.tools,
            {
              height: TOOLBAR_HEIGHT + 8 + (typing ? 8 : insets.bottom + 4),
              paddingBottom: typing ? 8 : insets.bottom + 4,
            },
          ]}
          onPress={deselect}
          accessible={false}>
          {typing ? (
            <CaptionTextBar
              key={`${typing.clipId}:w${typing.i}`}
              initial={typing.text}
              onDone={finishTyping}
              onCancel={() => setTyping(null)}
            />
          ) : captionTools ? (
            <CaptionTools
              lines={lines}
              timeMs={values.timeMs}
              hasWord={selWord >= 0}
              edited={captionsEdited}
              onDone={() => setMode('main')}
              onEdit={editCaption}
              onDelete={deleteCaption}
              onSplit={splitCaption}
              onMerge={mergeCaption}
              onModel={() => router.push('/on-device-ai')}
              onReset={resetCaptions}
            />
          ) : !sel ? (
            <MainToolbar
              canEdit={clips.length > 0}
              onEdit={() => {
                haptics.tap();
                setMode('edit');
                zoomToClip(clipIndexAt(layout.starts, ctl.lastMs));
              }}
              captionsBusy={captionsBusy}
              onCaptions={openCaptions}
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
          ) : tools === 'speed' ? (
            <SpeedRow
              speeds={speedMenu(customSpeeds)}
              speed={sel.edit.speed}
              onPick={(s) => edit('speed', (e) => ({ ...e, speed: s }))}
              onDone={() => setTools('clip')}
            />
          ) : (
            <ClipToolbar
              muted={sel.edit.muted}
              speed={sel.edit.speed}
              editable={sel.editable}
              edited={sel.editKey !== null || !sel.editable}
              onFlip={() => edit(null, flippedEdit)}
              onRotate={() => edit('rotate', rotated)}
              onCrop={startCrop}
              onMute={() => edit(null, (e) => ({ ...e, muted: !e.muted }))}
              onSpeed={() => setTools('speed')}
              onReset={reset}
              onDelete={remove}
              onDone={() => setMode('main')}
            />
          )}
        </Pressable>

        {cropping && cropClip && (
          <CropEditor
            uri={cropClip.uri}
            rotation={cropClip.merge.rotation}
            flipped={cropClip.edit.flipped}
            timeMs={cropping.timeMs}
            crop={cropClip.edit.crop}
            onCancel={() => setCropping(null)}
            onDone={finishCrop}
          />
        )}
        {/* Android draws its tips as callouts, over everything (iOS uses the system popover). */}
        <TipLayer />
      </KeyboardAvoidingView>
    </Sortable.PortalProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    height: 48,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  export: { marginLeft: 8 },
  switchSlot: { flex: 1, alignItems: 'flex-end' },
  track: { height: STRIP_HEIGHT },
  dim: { opacity: 0.35 },
  preview: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  cover: { position: 'absolute' },
  error: { textAlign: 'center', padding: 16 },
  transport: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  times: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  time: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    padding: 0,
    margin: 0,
  },
  timeNow: { minWidth: 46 },
  play: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tools: { justifyContent: 'center' },
});
