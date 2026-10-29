import type { MergeClip, MergeOptions } from '@mieweb/pulse-editor';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { deleteSegment, segmentsForDraft } from '@/db/drafts';
import type { Segment } from '@/db/schema';
import { mergeOptions, toMergeClip } from '@/features/export/editor-merge';
import { getRecorderFormat } from '@/features/recorder/recorder-format';
import { useToast } from '@/features/toast/toast-provider';
import { absolutize } from '@/utils/file-store';
import {
  canonicalEdit,
  editTimelineMs,
  effMs,
  parseEdit,
  segmentSignature,
  type ParsedEdit,
} from '@/utils/segment-window';
import { userMessage } from '@/utils/user-message';

import {
  getWrites,
  onWriteFailure,
  subscribeWrites,
  writeEdit,
  writeOrder,
  type EditValue,
} from './draft-writes';

export type { EditValue };

/** A clip as the editor shows and edits it. */
export type EditorClip = {
  id: string;
  label: string | null;
  /** The clip's settings (an unedited clip's defaults: whole, upright, 1x). */
  edit: ParsedEdit;
  /** The stored edit (canonical), or null when unedited. */
  editKey: string | null;
  /** False for a clip edited before edits were settings (a baked file): only reset and delete. */
  editable: boolean;
  /** Timeline length, ms. */
  lengthMs: number;
  /** The source file's length, ms. */
  sourceMs: number;
  /** The file the clip plays (`file://`). */
  uri: string;
  merge: MergeClip;
};

/** The length of the file the clip plays: a legacy baked edit's own, else the original's. */
const sourceMsOf = (s: Segment) =>
  s.editedFilename ? (s.editedDurationMs ?? s.durationMs) : s.durationMs;

const defaults = (s: Segment): ParsedEdit => ({
  startMs: 0,
  endMs: sourceMsOf(s),
  rotation: 0,
  flipped: false,
  crop: null,
  muted: false,
  speed: 1,
});

/** The row as it will be once a pending write lands. */
function withPending(s: Segment, value: EditValue | undefined): Segment {
  if (value === undefined) return s;
  return {
    ...s,
    editState: value,
    editedFilename: null,
    editedDurationMs: value ? editTimelineMs(value) : null,
  };
}

/** Position of `id` in `order`; ids it doesn't name go last, in their own order. */
const rank = (order: readonly string[], id: string) => {
  const i = order.indexOf(id);
  return i < 0 ? order.length : i;
};

/** True once the row holds `value`. */
const settled = (s: Segment, value: EditValue) =>
  value === null ? !s.editState && !s.editedFilename : canonicalEdit(s.editState) === value;

function toEditorClip(s: Segment): EditorClip {
  const legacy = !!s.editedFilename;
  const merge = toMergeClip(s);
  return {
    id: s.id,
    label: s.label,
    edit: (legacy ? null : parseEdit(s.editState)) ?? defaults(s),
    editKey: legacy ? null : canonicalEdit(s.editState),
    editable: !legacy,
    lengthMs: effMs(s),
    sourceMs: sourceMsOf(s),
    uri: merge.uri,
    merge,
  };
}

/**
 * The draft as the editor works on it: the live rows with the edits still being written laid
 * over them (so four quick rotates show at once, and the preview rebuilds once per change), and
 * writes that run one at a time per clip with only the newest pending one kept (draft-writes.ts,
 * shared by every editor). The database stays the truth: a pending edit drops away once no write
 * for it is left and its row holds it, or when it fails.
 */
export function useEditorDraft(draftId: string) {
  const { data: rows, updatedAt, error } = useLiveQuery(segmentsForDraft(draftId), [draftId]);
  const { showToast } = useToast();
  // A failed read leaves the last rows (none, on open) in place: say so, rather than wait.
  useEffect(() => {
    if (!error) return;
    showToast({
      kind: 'error',
      title: 'Couldn’t open the clips',
      message: userMessage(error, 'Try again.', 'load draft'),
    });
  }, [error, showToast]);
  const [pending, setPending] = useState<ReadonlyMap<string, EditValue>>(new Map());
  const writes = useSyncExternalStore(subscribeWrites, getWrites);

  // Drop pending edits the rows now hold once nothing is left to write for them (render-phase
  // adjustment, no extra commit): an older write landing first (a rotate, then its undo) can make
  // the row match for a moment, and the pending value must hold until the newest one lands.
  const landed = [...pending].filter(([id, v]) => {
    if (writes.edits.has(id)) return false;
    const row = rows.find((r) => r.id === id);
    return !row || settled(row, v);
  });
  if (landed.length) {
    const next = new Map(pending);
    for (const [id] of landed) next.delete(id);
    setPending(next);
  }

  // A reorder shows at once, until the rows hold it (or it fails).
  const [pendingOrder, setPendingOrder] = useState<readonly string[] | null>(null);
  const rowOrder = rows.map((r) => r.id);
  if (pendingOrder && !writes.order && rowOrder.filter((id) => pendingOrder.includes(id)).join() === pendingOrder.filter((id) => rowOrder.includes(id)).join()) {
    setPendingOrder(null);
  }
  const ordered = pendingOrder
    ? [...rows].sort((a, b) => rank(pendingOrder, a.id) - rank(pendingOrder, b.id))
    : rows;

  const segments = ordered.map((s) => withPending(s, pending.get(s.id))).filter((s) => effMs(s) > 0);

  // Clips change identity only when what they render changes (a new array rebuilds the preview):
  // a cover landing later, or a label, keeps the same clips.
  const signature = segmentSignature(segments);
  const [built, setBuilt] = useState<{ signature: string; clips: EditorClip[] } | null>(null);
  let clips = built?.clips ?? [];
  if (built?.signature !== signature) {
    clips = segments.map(toEditorClip);
    setBuilt({ signature, clips });
  }
  // Covers and labels follow the rows without rebuilding the clips.
  const covers = new Map(segments.map((s) => [s.id, s.thumbnail ? absolutize(s.thumbnail) : null]));

  const [options, setOptions] = useState<MergeOptions | null>(null);
  useEffect(() => {
    let live = true;
    void getRecorderFormat().then((f) => live && setOptions(mergeOptions(f)));
    return () => {
      live = false;
    };
  }, []);

  // A write that failed: its pending value drops (the row is the truth) and the person is told.
  useEffect(
    () =>
      onWriteFailure(({ id, error: e }) => {
        if (id === null) {
          setPendingOrder(null);
          showToast({
            kind: 'error',
            title: 'Couldn’t move the clip',
            message: userMessage(e, 'Try again.', 'reorder clips'),
          });
          return;
        }
        setPending((p) => {
          const n = new Map(p);
          n.delete(id);
          return n;
        });
        showToast({
          kind: 'error',
          title: 'Couldn’t save the edit',
          message: userMessage(e, 'Try again.', 'edit clip'),
        });
      }),
    [showToast],
  );

  const write = (id: string, value: EditValue) => {
    setPending((p) => new Map(p).set(id, value));
    writeEdit(id, value);
  };

  /** Store `edit` for a clip (canonical form). */
  const setEdit = (id: string, edit: ParsedEdit) => write(id, canonicalEdit(JSON.stringify(edit)));

  /** Put the clips in this order (the editor's clips; any it hides, zero-length, go last). */
  const reorder = (ids: string[]) => {
    const all = [...ids, ...rows.map((r) => r.id).filter((id) => !ids.includes(id))];
    setPendingOrder(all);
    writeOrder(all);
  };

  const remove = async (id: string) => {
    try {
      await deleteSegment(id);
    } catch (e) {
      showToast({
        kind: 'error',
        title: 'Couldn’t delete the clip',
        message: userMessage(e, 'Try again.', 'delete clip'),
      });
    }
  };

  return {
    /** False until the rows are first read (or the read failed). */
    loaded: updatedAt !== undefined || error !== undefined,
    clips,
    covers,
    options,
    setEdit,
    /** Store a raw value (undo/redo): an edit string, or null to reset. */
    setValue: write,
    reorder,
    remove,
  };
}
