import { probe, PulsePreview } from '@mieweb/pulse-editor';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, {
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import Sortable from 'react-native-sortables';

import { ClipRow } from '@/features/editor/clip-row';
import { useHandoff } from '@/features/editor/drag-handoff';
import { ClipToolbar, SpeedRow, TOOLBAR_HEIGHT } from '@/features/editor/clip-toolbar';
import { CropEditor } from '@/features/editor/crop-editor';
import {
  STRIP_HEIGHT,
  TimelineStrip,
  type TrimInfo,
  type TrimSide,
} from '@/features/editor/timeline-strip';
import {
  clamp,
  clipIndexAt,
  flippedEdit,
  formatTime,
  rotated,
  timelineLayout,
} from '@/features/editor/timeline-geometry';
import { getEditorView, setEditorView, type EditorView } from '@/db/settings';
import { useEditorDraft, type EditorClip } from '@/features/editor/use-editor-draft';
import { useEditorHistory } from '@/features/editor/use-editor-history';
import { usePreviewTransport } from '@/features/editor/use-preview-transport';
import { useWaveforms } from '@/features/editor/use-waveforms';
import { loadCustomSpeeds, speedMenu } from '@/features/recorder/editor-speeds';
import { useTheme } from '@/hooks/use-theme';
import { haptics } from '@/utils/haptics';
import type { ClipCrop, ParsedEdit } from '@/utils/segment-window';

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

/** Back to the recorder (or Home, when the editor was opened by a link). */
const close = () => (router.canGoBack() ? router.back() : router.replace('/'));

/** Each file's frame rate (for frame-snapped trims), probed once per file. 30 until known. */
const frameRates = new Map<string, number>();
function useFrameRates(uris: readonly string[]) {
  const [, setKnown] = useState(0);
  const key = [...new Set(uris)].join('\n');
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const uri of key.split('\n')) {
        if (!uri || frameRates.has(uri)) continue;
        try {
          const fps = (await probe(uri)).video?.fps ?? 0;
          frameRates.set(uri, fps > 0 ? fps : 30);
        } catch {
          frameRates.set(uri, 30);
        }
        if (live) setKnown((n) => n + 1);
      }
    })();
    return () => {
      live = false;
    };
  }, [key]);
  return (uri: string) => frameRates.get(uri) ?? 30;
}

/**
 * The timeline editor: the draft playing as it will export (<PulsePreview>), a strip of its
 * clips under a centre playhead, and the selected clip's tools. Every edit applies at once (no
 * Save), with undo/redo in the header; trims snap to source frames as the engine does.
 */
export default function EditorScreen() {
  const params = useLocalSearchParams<{ draftId: string; clipId?: string; view?: string }>();
  const { draftId, clipId } = params;
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const draft = useEditorDraft(draftId);
  const { clips, covers, options } = draft;
  const { ctl, values, playing, status } = usePreviewTransport();
  const history = useEditorHistory(clips, draft.setValue, draft.reorder);
  const fpsOf = useFrameRates(clips.map((c) => c.uri));
  const peaks = useWaveforms(
    clips.map((c) => c.uri),
    !!status?.ready,
  );

  // A hold on the timeline moving a clip: the held clip and where the finger was.
  const handoff = useHandoff();
  const [holding, setHolding] = useState<{ index: number; fingerX: number } | null>(null);
  // Clips (thumbnails, for picking and reordering) or Timeline (lengths, scrub, trim): the one
  // last switched to, remembered across sessions (Clips the first time).
  const [view, setView] = useState<EditorView>(
    () => getEditorView() ?? (params.view === 'timeline' ? 'timeline' : 'clips'),
  );
  const [tools, setTools] = useState<'clip' | 'speed'>('clip');
  const [cropping, setCropping] = useState<{ id: string; timeMs: number } | null>(null);
  const [trimmingId, setTrimmingId] = useState<string | null>(null);
  const [customSpeeds, setCustomSpeeds] = useState<readonly number[]>([]);
  // The preview area, and the picture fitted in it at the canvas's aspect: the player is sized to
  // the picture, so what's around it is the theme's background (not the player's black bars).
  const [stage, setStage] = useState({ w: 0, h: 0 });
  useEffect(() => {
    void loadCustomSpeeds().then(setCustomSpeeds);
  }, []);

  // Positions come from the engine once its status describes these clips (see timelineLayout).
  const layout = useMemo(
    () =>
      timelineLayout(
        clips.map((c) => c.lengthMs),
        status,
      ),
    [clips, status],
  );

  // Selection: a tapped clip (its tools open, the playhead goes to its start), kept while the
  // playhead plays or is scrubbed, for as long as the clip is on screen in either view; once it
  // scrolls out of view it's let go, so the clip being edited is always the one in red.
  // Nothing selected on open (a clip tapped in the recorder opens playing from it, see below).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const found = selectedId ? clips.findIndex((c) => c.id === selectedId) : -1;
  // A deleted clip can't stay selected (render-phase reset).
  if (selectedId && draft.loaded && clips.length && found < 0) setSelectedId(null);
  const current = found;
  if (current < 0 && tools !== 'clip') setTools('clip');

  // The preview's clips: the draft's, with the clip being trimmed played whole so the handle can
  // show frames past the current trim. Stable while those don't change (a new array rebuilds).
  const previewClips = useMemo(
    () => clips.map((c) => (c.id === trimmingId ? { ...c.merge, startMs: 0, endMs: 0 } : c.merge)),
    [clips, trimmingId],
  );

  // Android back leaves crop or the speed row first, then the editor.
  useEffect(() => {
    if (!cropping && tools === 'clip') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (cropping) setCropping(null);
      else setTools('clip');
      return true;
    });
    return () => sub.remove();
  }, [cropping, tools]);

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
    // Opened from a clip in the recorder: play the draft on from that clip's start.
    ctl.place(i > 0 ? (layout.starts[i] ?? 0) : 0, !!clipId);
    placed.set(1);
  }, [clips, clipId, ctl, layout.starts, placed]);
  const trackStyle = useAnimatedStyle(() => ({ opacity: placed.get() }));
  const coverStyle = useAnimatedStyle(() => ({ opacity: values.covered.get() }));

  /** A reorder let go: store the new order (clip ids, slot by slot) if it changed; the moved clip
   * is selected at its new place, with the playhead on its start. */
  const deselect = () => setSelectedId(null);
  const keepSelection = useRef(0);
  /** The selected clip scrolled out of view: let it go (unless a drop just placed it). */
  const onSelectedHidden = () => {
    if (Date.now() > keepSelection.current) setSelectedId(null);
  };
  const commitOrder = (ids: string[], held: string) => {
    if (ids.length !== clips.length || ids.every((id, i) => id === clips[i].id)) return;
    haptics.drop();
    history.record(null);
    draft.reorder(ids);
    setSelectedId(held);
    // The order lands a moment before the playhead's seek: don't let the moved clip go meanwhile.
    keepSelection.current = Date.now() + 600;
    let at = 0;
    for (const id of ids) {
      if (id === held) break;
      at += clips.find((c) => c.id === id)?.lengthMs ?? 0;
    }
    ctl.seekTo(at);
  };

  /** A tap on a clip (either view) selects it, the playhead and playback left as they are; a tap
   * on the selected clip lets it go. */
  const tapClip = (i: number) => {
    const c = clips[i];
    if (!c) {
      setSelectedId(null);
      return;
    }
    haptics.tap();
    if (c.id === selectedId) {
      setSelectedId(null);
      return;
    }
    setSelectedId(c.id);
  };

  const slotOf = (i: number) => {
    const start = layout.starts[i] ?? 0;
    const end = i + 1 < layout.starts.length ? layout.starts[i + 1] : layout.totalMs;
    return { start, end };
  };

  /** The clip the tools act on: the selected one (the tools show only while one is). */
  const target = (): { clip: EditorClip; index: number } | null =>
    current >= 0 ? { clip: clips[current], index: current } : null;

  const edit = (opKey: string | null, change: (e: ParsedEdit) => ParsedEdit) => {
    const t = target();
    if (!t || !t.clip.editable) return;
    haptics.tap();
    history.record(opKey && `${opKey}:${t.clip.id}`);
    draft.setEdit(t.clip.id, change(t.clip.edit));
  };

  const onTap = (ms: number) => {
    if (ms < 0 || ms > layout.totalMs) {
      setSelectedId(null);
      return;
    }
    tapClip(clipIndexAt(layout.starts, ms));
  };

  const sel = current >= 0 ? clips[current] : null;
  const trim: TrimInfo | null = sel?.editable
    ? {
        startMs: sel.edit.startMs,
        endMs: sel.edit.endMs,
        sourceMs: sel.sourceMs,
        speed: sel.edit.speed,
        slotStartMs: slotOf(current).start,
        frameMs: 1000 / fpsOf(sel.uri),
      }
    : null;

  const onTrimStart = () => {
    // A trim is never part of a hold: drop any reorder overlay left up.
    setHolding(null);
    if (!sel) return;
    haptics.pickUp();
    setTrimmingId(sel.id);
    ctl.beginDrag();
  };

  const onTrimEnd = (side: TrimSide, ms: number) => {
    setTrimmingId(null);
    if (!sel || !trim) {
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
    // As RNVT: the playhead goes to the new start, or to the last frame before the new end.
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

  const remove = () => {
    const t = target();
    if (!t) return;
    haptics.drop();
    setSelectedId(null);
    void draft.remove(t.clip.id);
  };

  const reset = () => {
    const t = target();
    if (!t) return;
    haptics.tap();
    history.record(null);
    draft.setValue(t.clip.id, null);
  };

  const { timeMs } = values;
  const timeProps = useAnimatedProps(() => {
    const text = formatTime(timeMs.get());
    return { text, defaultValue: text } as object;
  });

  const active = sel ?? null;
  const cropClip = cropping ? clips.find((c) => c.id === cropping.id) : null;
  const aspect = options ? options.width / options.height : 9 / 16;
  const fitW = Math.min(stage.w, stage.h * aspect);
  const picture = { width: fitW, height: fitW / aspect };

  return (
    // The portal lifts a picked-up clip above everything (preview, controls) while it's dragged.
    <Sortable.PortalProvider>
      <View style={[styles.root, { paddingTop: insets.top, backgroundColor: theme.background }]}>
        {/* Off-clip space, like every black area around the controls: a tap lets a selection go. */}
        <Pressable style={styles.header} onPress={deselect} accessible={false}>
          <HeaderButton icon="xmark" label="Close" onPress={close} />
          <View style={styles.headerRight}>
            <HeaderButton
              icon="arrow.uturn.backward"
              label="Undo"
              onPress={history.undo}
              disabled={!history.canUndo}
            />
            <HeaderButton
              icon="arrow.uturn.forward"
              label="Redo"
              onPress={history.redo}
              disabled={!history.canRedo}
            />
          </View>
        </Pressable>

        <Pressable
          style={[styles.preview, { backgroundColor: theme.background }]}
          onLayout={(e) =>
            setStage({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
          }
          // A tap off the clips lets a selection go first; otherwise it plays or pauses.
          onPress={() => (selectedId ? setSelectedId(null) : ctl.toggle())}
          accessibilityRole="button"
          accessibilityLabel={selectedId ? 'Done editing the clip' : playing ? 'Pause' : 'Play'}>
          {/* Created once the area is measured, at the picture's size. */}
          {options && previewClips.length > 0 && fitW > 0 && (
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
                setHolding(null);
                setView(v);
                void setEditorView(v).catch(() => {});
              }}
            />
          </View>
        </Pressable>

        {view === 'timeline' ? (
          <Animated.View style={[styles.track, trackStyle]}>
            <TimelineStrip
              clips={clips}
              covers={covers}
              peaks={peaks}
              layout={layout}
              selected={current}
              trim={trim}
              values={values}
              handoff={handoff}
              hidden={!!holding}
              onHold={(i, fingerX) => {
                // The clips turn into the Clips row over the strip, the held one under the finger.
                const c = clips[i];
                if (!c) return;
                ctl.pause();
                setSelectedId(c.id);
                setHolding({ index: i, fingerX });
              }}
              onHoldEnd={() => {
                // After sortables' drop animation (the order is stored by its onDragEnd).
                setTimeout(() => setHolding(null), 300);
              }}
              onDragStart={ctl.beginDrag}
              onScrubEnd={ctl.endScrub}
              onTap={onTap}
              onSelectedHidden={onSelectedHidden}
              onTrimStart={onTrimStart}
              onTrimEnd={onTrimEnd}
            />
            {holding && (
              <View style={StyleSheet.absoluteFill} pointerEvents="none">
                <ClipRow
                  clips={clips}
                  covers={covers}
                  layout={layout}
                  selected={current}
                  values={values}
                  handoff={{ state: handoff, ...holding }}
                  onSelect={() => {}}
                  onSelectedHidden={() => {}}
                  onDragStart={() => {}}
                  onScrubEnd={() => {}}
                  onReorderStart={() => {}}
                  onReorder={commitOrder}
                />
              </View>
            )}
          </Animated.View>
        ) : (
          <Animated.View style={[styles.track, trackStyle]}>
            <ClipRow
              clips={clips}
              covers={covers}
              layout={layout}
              selected={current}
              values={values}
              onSelect={(id) => tapClip(clips.findIndex((c) => c.id === id))}
              onSelectedHidden={onSelectedHidden}
              onDragStart={ctl.beginDrag}
              onScrubEnd={ctl.endScrub}
              onReorderStart={ctl.pause}
              onReorder={commitOrder}
              onBlankTap={() => setSelectedId(null)}
            />
          </Animated.View>
        )}

        <Pressable
          // One height whether it holds the tools or the hint, so selecting never moves the layout.
          style={[
            styles.tools,
            { height: TOOLBAR_HEIGHT + 8 + insets.bottom + 4, paddingBottom: insets.bottom + 4 },
          ]}
          onPress={deselect}
          accessible={false}>
          {!active ? (
            <Text style={[styles.hint, { color: theme.textSecondary }]}>Tap a clip to edit it</Text>
          ) : tools === 'speed' ? (
            <SpeedRow
              speeds={speedMenu(customSpeeds)}
              speed={active.edit.speed}
              onPick={(s) => edit('speed', (e) => ({ ...e, speed: s }))}
              onDone={() => setTools('clip')}
            />
          ) : (
            <ClipToolbar
              muted={active.edit.muted}
              speed={active.edit.speed}
              editable={active.editable}
              edited={active.editKey !== null || !active.editable}
              onFlip={() => edit(null, flippedEdit)}
              onRotate={() => edit('rotate', rotated)}
              onCrop={startCrop}
              onMute={() => edit(null, (e) => ({ ...e, muted: !e.muted }))}
              onSpeed={() => setTools('speed')}
              onReset={reset}
              onDelete={remove}
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
      </View>
    </Sortable.PortalProvider>
  );
}

/** Clips | Timeline: which way the draft's clips are shown below the preview. */
function ViewSwitcher({
  view,
  onChange,
}: {
  view: 'clips' | 'timeline';
  onChange: (view: 'clips' | 'timeline') => void;
}) {
  const theme = useTheme();
  const options = [
    { key: 'clips', label: 'Clips', icon: 'rectangle.split.3x1' },
    { key: 'timeline', label: 'Timeline', icon: 'waveform' },
  ] as const;
  return (
    <View
      style={[styles.switcher, { backgroundColor: theme.backgroundElement }]}
      accessibilityRole="tablist">
      {options.map((o) => {
        const on = view === o.key;
        return (
          <Pressable
            key={o.key}
            onPress={() => {
              if (on) return;
              haptics.tap();
              onChange(o.key);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${o.label} view`}
            style={[styles.switchOption, on && { backgroundColor: theme.text }]}>
            <Icon
              name={o.icon}
              size={16}
              weight="semibold"
              tintColor={on ? theme.background : theme.text}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

function HeaderButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.headerButton, (disabled || pressed) && styles.dim]}>
      <Icon name={icon} size={18} weight="semibold" tintColor={theme.text} />
    </Pressable>
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
  headerRight: { flexDirection: 'row', gap: 4 },
  switcher: {
    flexDirection: 'row',
    padding: 2,
    borderRadius: 17,
  },
  switchSlot: { flex: 1, alignItems: 'flex-end' },
  switchOption: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 44,
    height: 30,
    borderRadius: 15,
  },
  track: { height: STRIP_HEIGHT },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  hint: { fontSize: 14, textAlign: 'center' },
});
