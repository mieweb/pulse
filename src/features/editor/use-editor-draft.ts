import type { MergeClip, MergeOptions } from '@mieweb/pulse-editor';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useRef, useState } from 'react';

import {
  deleteSegment,
  reorderSegments,
  resetEdit,
  segmentsForDraft,
  setEditState,
} from '@/db/drafts';
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

/** An edit as stored, or null for "no edit" (reset). */
export type EditValue = string | null;

const defaults = (s: Segment): ParsedEdit => ({
  startMs: 0,
  endMs: s.durationMs,
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
    sourceMs: s.durationMs,
    uri: merge.uri,
    merge,
  };
}

/**
 * The draft as the editor works on it: the live rows with the edits still being written laid
 * over them (so four quick rotates show at once, and the preview rebuilds once per change), and
 * writes that run one at a time per clip with only the newest pending one kept. The database
 * stays the truth: a pending edit drops away as soon as its row holds it, or when it fails.
 */
export function useEditorDraft(draftId: string) {
  const { data: rows, updatedAt } = useLiveQuery(segmentsForDraft(draftId), [draftId]);
  const { showToast } = useToast();
  const [pending, setPending] = useState<ReadonlyMap<string, EditValue>>(new Map());

  // Drop pending edits the rows now hold (render-phase adjustment, no extra commit).
  const landed = [...pending].filter(([id, v]) => {
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
  if (pendingOrder && rowOrder.filter((id) => pendingOrder.includes(id)).join() === pendingOrder.filter((id) => rowOrder.includes(id)).join()) {
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

  // Latest-wins writer: per clip, one write at a time, and only the newest waiting value.
  const queue = useRef({ next: new Map<string, EditValue>(), running: new Set<string>() });
  const write = (id: string, value: EditValue) => {
    setPending((p) => new Map(p).set(id, value));
    const q = queue.current;
    q.next.set(id, value);
    if (q.running.has(id)) return;
    q.running.add(id);
    void (async () => {
      while (q.next.has(id)) {
        const v = q.next.get(id) ?? null;
        q.next.delete(id);
        try {
          if (v === null) await resetEdit(id);
          else await setEditState(id, v);
        } catch (e) {
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
        }
      }
      q.running.delete(id);
    })();
  };

  /** Store `edit` for a clip (canonical form). */
  const setEdit = (id: string, edit: ParsedEdit) => write(id, canonicalEdit(JSON.stringify(edit)));

  /** Put the clips in this order (the editor's clips; any it hides, zero-length, go last). */
  const reorder = (ids: string[]) => {
    const all = [...ids, ...rows.map((r) => r.id).filter((id) => !ids.includes(id))];
    setPendingOrder(all);
    reorderSegments(all).catch((e: unknown) => {
      setPendingOrder(null);
      showToast({
        kind: 'error',
        title: 'Couldn’t move the clip',
        message: userMessage(e, 'Try again.', 'reorder clips'),
      });
    });
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
    /** False until the rows are first read. */
    loaded: updatedAt !== undefined,
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
