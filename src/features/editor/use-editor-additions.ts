import { useEffect, useEffectEvent, useRef } from 'react';
import type { SharedValue } from 'react-native-reanimated';

import {
  anchorForPlayhead,
  expectClipsAdded,
  onClipsAdded,
  takeClipsAdded,
  takeEditorReturn,
} from '@/core/clip-anchor';
import { useFromAnotherPulse } from '@/features/recorder/from-another-pulse';
import { useScreenTake } from '@/features/recorder/screen-take';
import { useImportImages } from '@/features/recorder/use-import-images';
import { useImportVideo } from '@/features/recorder/use-import-video';

import type { EditorScreenProps } from './contract';
import { usePlayheadSlot } from './editor-add-menu';
import {
  batchWriting,
  editorAddActions,
  groupAdditions,
  type ImageBatch,
  playheadGoal,
  type PlayheadGoal,
  playheadGoalMs,
} from './editor-additions';

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
  pause,
  seekTo,
  endTrim,
  recordAdded,
  leaveEditMode,
  openOver,
  onAddClips,
  screenCapture,
  placeLabels,
}: {
  draftId: string;
  clips: readonly { id: string }[];
  layout: { starts: readonly number[]; totalMs: number };
  timeMs: SharedValue<number>;
  focused: boolean;
  pause: () => void;
  seekTo: (ms: number) => void;
  /** Once the preview has the new clips (as a trim's end). */
  endTrim: (ms: number) => void;
  /** One undo step for an addition. */
  recordAdded: (ids: string[]) => void;
  leaveEditMode: () => void;
  /** Open a screen over the editor, once its pending writes are stored. */
  openOver: (go: () => void) => void;
} & Pick<EditorScreenProps, 'onAddClips' | 'screenCapture' | 'placeLabels'>) {
  // Not compiled by the React Compiler, as the editor screen it came out of isn't.
  'use no memo';
  // Where the "+" adds: the playhead's clip boundary (`anchorForPlayhead`). Selected clip or not,
  // the playhead decides. The slot follows the playhead for the hint.
  const clipIds = clips.map((c) => c.id);
  const anchorNow = () => anchorForPlayhead(clipIds, layout.starts, layout.totalMs, timeMs.get());
  const slot = usePlayheadSlot(layout.starts, layout.totalMs, timeMs);
  const importer = useImportVideo();
  const images = useImportImages();
  const screen = useScreenTake(screenCapture);
  const screenLive = screen.phase !== 'idle';
  const anotherPulse = useFromAnotherPulse({
    draftId,
    target: async () => draftId,
    anchor: anchorNow,
    onOpen: pause,
    placeLabels,
  });

  // A batch of images' clips, told apart as they're written (`onWriting`), to be one undo step.
  const imageBatch = useRef<ImageBatch | null>(null);
  // The items' callbacks run on a press, never during render: the ref is only read then.
  // eslint-disable-next-line react-hooks/refs
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
      void images.importImages(draftId, () => anchor, {
        onWriting: (id) => {
          imageBatch.current = batchWriting(imageBatch.current, id);
        },
      }),
    fromAnotherPulse: anotherPulse.action ?? undefined,
  });

  useEffect(() => expectClipsAdded(draftId), [draftId]);
  // A goal not reached yet: its clip not in the list, or placed by a list a beat behind the clips
  // just added. Tried again as the clips change, until `until`.
  const pendingGoal = useRef<{ goal: PlayheadGoal; until: number } | null>(null);
  /** The playhead to `goal` (`playheadGoalMs`); false while its clip isn't in the list yet. */
  const placeGoal = (goal: PlayheadGoal, rebuilt: boolean) => {
    const at = playheadGoalMs(goal, clipIds, layout.starts, layout.totalMs);
    if (at == null) return false;
    // Clips just changed: once the preview has the new clips (as a trim's end); else at once.
    if (rebuilt) endTrim(at);
    else seekTo(at);
    return true;
  };
  const takeAdded = useEffectEvent(() => {
    const added = takeClipsAdded(draftId);
    const grouped = groupAdditions(imageBatch.current, added, images.importing);
    imageBatch.current = grouped.batch;
    for (const ids of grouped.steps) recordAdded(ids);
    const goal = playheadGoal(takeEditorReturn(draftId), grouped.placeAfter);
    if (!goal) return;
    leaveEditMode();
    const placed = placeGoal(goal, false);
    // A place from the recorder resolves with any list, but one behind the clips just added puts
    // it short of them: once more as the list catches up, briefly (an id can also be one the
    // recorder deleted again, a retake, which never shows up).
    const behind = 'at' in goal && added.some((id) => !clipIds.includes(id));
    pendingGoal.current =
      !placed || behind ? { goal, until: Date.now() + (behind ? 1500 : 5000) } : null;
  });
  useEffect(() => {
    const p = pendingGoal.current;
    if (!p) return;
    if (Date.now() > p.until) pendingGoal.current = null;
    else if (placeGoal(p.goal, true)) pendingGoal.current = null;
    // Only a change of the clips places it (the layout follows them).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips]);
  const imagesWere = useRef(false);
  useEffect(() => {
    const ended = imagesWere.current && !images.importing;
    imagesWere.current = images.importing;
    if (ended && focused) takeAdded();
  }, [focused, images.importing]);
  useEffect(() => {
    if (!focused) return;
    // Those added while a recorder covered the editor, just after it's back on top.
    const back = setTimeout(takeAdded, 0);
    const stop = onClipsAdded((added) => {
      if (added.draftId === draftId) takeAdded();
    });
    return () => {
      clearTimeout(back);
      stop();
    };
  }, [focused, draftId]);

  return {
    actions,
    /** An import, a batch or this draft's screen take is adding clips: the "+" is busy. */
    busy:
      importer.importing || images.importing || (screen.importing && screen.draftId === draftId),
    progress: importer.importing
      ? importer.progress
      : images.importing
        ? images.progress
        : screen.progress,
    progressText: images.importing ? images.stepText : undefined,
    progressCount: images.importing ? images.stepCount : undefined,
    /** The slot the "+" adds at now, for its hint. */
    slot,
    screen,
    /** A screen take for this draft is starting or live: its Stop shows over the preview. */
    screenHere: screen.draftId === draftId && (screenLive || screen.starting),
    screenLive,
    /** "From another Pulse"'s sheet, to render. */
    anotherPulseSheet: anotherPulse.sheet,
  };
}
