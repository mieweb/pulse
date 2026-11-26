import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import type { SharedValue } from 'react-native-reanimated';

import {
  END,
  type ClipAnchor,
  expectClipsAdded,
  onClipsAdded,
  takeClipsAdded,
  takeClipSplits,
  takeEditorReturn,
} from '@/core/clip-anchor';
import { dropTakenOut, type SplitReceipt } from '@/db/drafts';
import type { EditorView } from '@/db/settings';
import { useFromAnotherPulse } from '@/features/recorder/from-another-pulse';
import { useScreenTake } from '@/features/recorder/screen-take';
import { useImportImages } from '@/features/recorder/use-import-images';
import { useImportVideo } from '@/features/recorder/use-import-video';

import type { EditorScreenProps } from './contract';
import { clearUndoAdditionBatch, markUndoAdditionBatch } from '@/core/undo-additions';
import type { EditorClip } from './use-editor-draft';
import {
  batchWriting,
  editorAddAnchor,
  editorAddActions,
  groupAdditions,
  type ImageBatch,
  playheadGoal,
  type PlayheadGoal,
  playheadGoalMs,
} from './editor-additions';

type ActiveImageBatch = {
  group: ImageBatch;
  closed: boolean;
  end: () => void;
};

function closeImageBatch(batch: ActiveImageBatch) {
  if (batch.closed) return;
  batch.closed = true;
  batch.end();
}

/**
 * The editor's "+" (#308): its items (`editorAddActions`), the imports and screen take they run,
 * and the clips they add. Clips added to this draft while the editor is open, from its "+" or a
 * recorder over it, become undo steps (`groupAdditions`), and the playhead goes right after the
 * last one. They're taken when they land while the editor is on top, else all together once it is
 * back on top. A recorder that came back here on its Edit sets the playhead instead: at its insert
 * cursor, or the clip tapped there (`returnEditorTo`).
 */
export function useEditorAdditions({
  draftId,
  clips,
  layout,
  timeMs,
  focused,
  view,
  previewReady,
  pause,
  seekTo,
  recordAdded,
  beginBatch,
  endBatch,
  leaveEditMode,
  openOver,
  onAddClips,
  screenCapture,
  placeLabels,
}: {
  draftId: string;
  clips: readonly Pick<EditorClip, 'id' | 'edit' | 'sourceKey'>[];
  layout: { starts: readonly number[]; totalMs: number };
  timeMs: SharedValue<number>;
  focused: boolean;
  view: EditorView;
  /** The native preview is ready with this clip list, rather than the pre-insert timeline. */
  previewReady: boolean;
  pause: () => void;
  seekTo: (ms: number) => void;
  /** One undo step for an addition. */
  recordAdded: (ids: string[], splits?: readonly SplitReceipt[], batchKey?: string) => void;
  /** Prevent Undo/Redo while preparing a batch; its first commit creates the history step. */
  beginBatch: (key: string) => Promise<void>;
  endBatch: (key: string) => void;
  leaveEditMode: () => void;
  /** Open a screen over the editor, once its pending writes are stored. */
  openOver: (go: () => void) => void;
} & Pick<EditorScreenProps, 'onAddClips' | 'screenCapture' | 'placeLabels'>) {
  // Not compiled by the React Compiler, as the editor screen it came out of isn't.
  'use no memo';
  // Capture this view's insertion position when an action is chosen, before media preparation.
  const clipIds = clips.map((c) => c.id);
  const anchorNow = () => editorAddAnchor(view, clips, layout, timeMs.get(), randomUUID);
  const importer = useImportVideo();
  const images = useImportImages();
  const screen = useScreenTake(screenCapture);
  const screenLive = screen.phase !== 'idle';
  const otherAnchor = useRef<ClipAnchor>(END);
  const anotherPulse = useFromAnotherPulse({
    draftId,
    target: async () => draftId,
    anchor: () => otherAnchor.current,
    onOpen: pause,
    placeLabels,
  });

  // A batch of images' clips, told apart as they're written (`onWriting`), to be one undo step.
  const imageBatch = useRef<ActiveImageBatch | null>(null);
  const mounted = useRef(false);
  const [batchActive, setBatchActive] = useState({ draftId, active: false });
  if (batchActive.draftId !== draftId) setBatchActive({ draftId, active: false });
  const pendingSplits = useRef<SplitReceipt[]>([]);
  const drainAdded = useRef<(finishBatch?: boolean) => void>(() => {});
  // The items' callbacks run on a press, never during render: the ref is only read then.
  // eslint-disable-next-line react-hooks/refs -- callbacks read refs only when an item is chosen
  const actions = editorAddActions({
    anchorNow,
    pause,
    record: onAddClips && ((anchor) => openOver(() => onAddClips(draftId, anchor))),
    recordScreen:
      screenCapture && !screenLive && !screen.importing
        ? (anchor) => void screenCapture.start(async () => draftId, true, anchor)
        : undefined,
    importVideo: (anchor) => importer.importVideo(draftId, anchor),
    importImages: (anchor) =>
      void importImagesAt(anchor).catch((error) =>
        console.warn('[editor] image batch failed', error),
      ),
    fromAnotherPulse: anotherPulse.action
      ? (anchor) => {
          otherAnchor.current = anchor;
          anotherPulse.action?.onPress();
        }
      : undefined,
  });

  useEffect(() => {
    mounted.current = true;
    const stop = expectClipsAdded(draftId, (split) => void dropTakenOut(split.before));
    return () => {
      mounted.current = false;
      const batch = imageBatch.current;
      imageBatch.current = null;
      if (batch) closeImageBatch(batch);
      // Receipts not yet grouped into history (e.g. an image batch still preparing) have no
      // owner once this editor closes. The live half rows keep their own media referenced.
      const remaining = pendingSplits.current;
      pendingSplits.current = [];
      for (const split of remaining) void dropTakenOut(split.before);
      stop();
    };
  }, [draftId]);
  // A goal not reached yet: its clip not in the list, or placed by a list a beat behind the clips
  // just added. Tried again as the clips change, until `until`.
  const pendingGoal = useRef<{ goal: PlayheadGoal; until: number } | null>(null);
  /** The playhead to `goal` (`playheadGoalMs`); false while its clip isn't in the list yet. */
  const placeGoal = (goal: PlayheadGoal) => {
    const at = playheadGoalMs(goal, clipIds, layout.starts, layout.totalMs);
    if (at == null || !previewReady || !focused) return false;
    // Rows can arrive before the native timeline has rebuilt. Seeking its old item loses this
    // position when it is replaced; retain the goal until this clip list is ready to seek.
    seekTo(at);
    return true;
  };
  const drainNow = (finishBatch = false) => {
    const added = takeClipsAdded(draftId);
    pendingSplits.current.push(...takeClipSplits(draftId));
    const batch = imageBatch.current;
    const grouped = groupAdditions(batch?.group ?? null, added, batch !== null && !finishBatch);
    if (batch && grouped.batch) batch.group = grouped.batch;
    for (const { ids, batchKey } of grouped.steps) {
      const ours = new Set(ids);
      const splits = pendingSplits.current.filter(
        (s) => s.firstInsertedId !== undefined && ours.has(s.firstInsertedId),
      );
      pendingSplits.current = pendingSplits.current.filter(
        (s) => s.firstInsertedId === undefined || !ours.has(s.firstInsertedId),
      );
      recordAdded(ids, splits, batchKey);
    }
    const goal = playheadGoal(focused ? takeEditorReturn(draftId) : null, grouped.placeAfter);
    if (!goal) return;
    leaveEditMode();
    const placed = placeGoal(goal);
    // A place from the recorder resolves with any list, but one behind the clips just added puts
    // it short of them: once more as the list catches up, briefly (an id can also be one the
    // recorder deleted again, a retake, which never shows up).
    const behind = 'at' in goal && added.some((id) => !clipIds.includes(id));
    pendingGoal.current =
      !placed || behind
        ? { goal, until: focused ? Date.now() + (behind ? 1500 : 5000) : Infinity }
        : null;
  };
  // Import completion is an event-handler continuation, not an Effect Event. Keep its drain
  // current after every commit, while the subscription/timer below uses an Effect Event.
  useLayoutEffect(() => {
    drainAdded.current = drainNow;
  });
  const takeAdded = useEffectEvent(() => drainAdded.current());

  async function importImagesAt(anchor: ClipAnchor) {
    // Own the whole promise, including permission/picker waits: importing state changes later.
    if (!mounted.current || imageBatch.current) return;
    const key = randomUUID();
    const batch: ActiveImageBatch = {
      group: { key, writing: [], landed: [] },
      closed: false,
      end: () => {
        clearUndoAdditionBatch(draftId, key);
        endBatch(key);
      },
    };
    imageBatch.current = batch;
    setBatchActive({ draftId, active: true });
    try {
      await beginBatch(key);
      if (!mounted.current || imageBatch.current !== batch) return;
      await images.importImages(draftId, () => anchor, {
        onWriting: (id) => {
          markUndoAdditionBatch(draftId, id, key);
          if (imageBatch.current === batch) batch.group = batchWriting(batch.group, id);
        },
      });
    } finally {
      try {
        // Closing/unmounting owns no global journal: another armed editor may be taking it.
        if (mounted.current && imageBatch.current === batch) drainAdded.current(true);
      } finally {
        if (imageBatch.current === batch) {
          imageBatch.current = null;
          if (mounted.current) setBatchActive({ draftId, active: false });
        }
        closeImageBatch(batch);
      }
    }
  }

  useEffect(() => {
    const p = pendingGoal.current;
    if (!p || !focused) return;
    // A batch can complete while covered. Start its placement deadline when this editor returns.
    if (p.until === Infinity) p.until = Date.now() + 5000;
    if (Date.now() > p.until) pendingGoal.current = null;
    else if (placeGoal(p.goal)) pendingGoal.current = null;
    // Rows and native readiness arrive independently; either can make the goal resolvable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips, previewReady, layout, focused]);
  useEffect(() => {
    // Those added while a recorder covered the editor, just after it's back on top.
    const back = focused ? setTimeout(takeAdded, 0) : null;
    const stop = onClipsAdded((added) => {
      // Own an image batch's history from its first commit, even while another screen covers us.
      if (added.draftId === draftId && (focused || imageBatch.current)) takeAdded();
    });
    return () => {
      if (back !== null) clearTimeout(back);
      stop();
    };
  }, [focused, draftId]);

  return {
    actions,
    /** An import, a batch or this draft's screen take is adding clips: the "+" is busy. */
    busy:
      importer.importing ||
      (batchActive.draftId === draftId && batchActive.active) ||
      images.importing ||
      (screen.importing && screen.draftId === draftId),
    progress: importer.importing
      ? importer.progress
      : images.importing
        ? images.progress
        : screen.progress,
    progressText: images.importing ? images.stepText : undefined,
    progressCount: images.importing ? images.stepCount : undefined,
    screen,
    /** A screen take for this draft is starting or live: its Stop shows in the lower controls. */
    screenHere: screen.draftId === draftId && (screenLive || screen.starting),
    screenLive,
    /** "From another Pulse"'s sheet, to render. */
    anotherPulseSheet: anotherPulse.sheet,
  };
}
