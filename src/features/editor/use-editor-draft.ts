import type { MergeClip, MergeOptions } from '@mieweb/pulse-editor';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { setCaptionEdits } from '@/db/captions';
import { deleteSegment, segmentsForDraft } from '@/db/drafts';
import { dropClipJobs } from '@/features/transcription/clip-queue';
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
import { useClipTranscription } from '@/features/transcription/use-clip-transcription';

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
  // Every clip (muted ones too, ready for an unmute) is transcribed in the background while the
  // editor is open; the captions ask for the ones they're missing at once (useDraftCaptions).
  useClipTranscription(rows, true);
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

  // Caption edits show at once too, until the rows hold them (or the write fails): a second edit
  // right after the first starts from the first's words, not from what the rows still say.
  const [pendingCaptions, setPendingCaptions] = useState<ReadonlyMap<string, string | null>>(
    new Map(),
  );
  // Caption writes still running, per clip (they land in the order made): as with the edits
  // above, an older write landing can make the row match for a moment (an edit, then its undo).
  const [captionWrites, setCaptionWrites] = useState<ReadonlyMap<string, number>>(new Map());
  const captionsLanded = [...pendingCaptions].filter(([id, v]) => {
    if (captionWrites.has(id)) return false;
    const row = rows.find((r) => r.id === id);
    return !row || (row.captionEdit ?? null) === v;
  });
  if (captionsLanded.length) {
    const next = new Map(pendingCaptions);
    for (const [id] of captionsLanded) next.delete(id);
    setPendingCaptions(next);
  }

  // A reorder shows at once, until the rows hold it (or it fails).
  const [pendingOrder, setPendingOrder] = useState<readonly string[] | null>(null);
  const rowOrder = rows.map((r) => r.id);
  if (
    pendingOrder &&
    !writes.order &&
    rowOrder.filter((id) => pendingOrder.includes(id)).join() ===
      pendingOrder.filter((id) => rowOrder.includes(id)).join()
  ) {
    setPendingOrder(null);
  }
  // The same array until the rows, the pending edits or the pending order change, so what's
  // composed from it (captions, spans) isn't redone on every render.
  const segments = useMemo(() => {
    const ordered = pendingOrder
      ? [...rows].sort((a, b) => rank(pendingOrder, a.id) - rank(pendingOrder, b.id))
      : rows;
    return ordered
      .map((s) => {
        const edited = withPending(s, pending.get(s.id));
        const caption = pendingCaptions.get(s.id);
        return caption === undefined ? edited : { ...edited, captionEdit: caption };
      })
      .filter((s) => effMs(s) > 0);
  }, [rows, pending, pendingOrder, pendingCaptions]);

  // Clips change identity only when what they render changes (a new array rebuilds the preview):
  // a cover landing later, or a label, keeps the same clips.
  const signature = segmentSignature(segments);
  const [built, setBuilt] = useState<{ signature: string; clips: EditorClip[] } | null>(null);
  let clips = built?.clips ?? [];
  if (built?.signature !== signature) {
    clips = segments.map(toEditorClip);
    setBuilt({ signature, clips });
  }
  // Covers, labels and caption edits follow the rows without rebuilding the clips.
  // Same maps (by identity) until one of them changes, so what they feed doesn't re-render.
  const coversKey = segments.map((s) => `${s.id}=${s.thumbnail ?? ''}`).join('|');
  const captionsKey = segments.map((s) => `${s.id}=${s.captionEdit ?? ''}`).join('\u0000');
  const covers = useMemo(
    () => new Map(segments.map((s) => [s.id, s.thumbnail ? absolutize(s.thumbnail) : null])),
    // `coversKey` is the segments' covers as one value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [coversKey],
  );
  const captionEdits = useMemo(
    () => new Map(segments.map((s) => [s.id, s.captionEdit])),
    // `captionsKey` is the segments' caption edits as one value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [captionsKey],
  );

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

  /** Store clips' edited captions (JSON, or null for the model's words again). */
  const countCaptionWrites = (ids: Iterable<string>, by: 1 | -1) =>
    setCaptionWrites((m) => {
      const n = new Map(m);
      for (const id of ids) {
        const left = (n.get(id) ?? 0) + by;
        if (left > 0) n.set(id, left);
        else n.delete(id);
      }
      return n;
    });

  const setCaptions = (values: ReadonlyMap<string, string | null>) => {
    setPendingCaptions((p) => new Map([...p, ...values]));
    countCaptionWrites(values.keys(), 1);
    setCaptionEdits(values)
      .catch((e: unknown) => {
        // The rows are the truth: what this write would have set drops (unless newer replaced it).
        setPendingCaptions((p) => {
          const n = new Map(p);
          for (const [id, v] of values) if (n.get(id) === v) n.delete(id);
          return n;
        });
        showToast({
          kind: 'error',
          title: 'Couldn’t save the captions',
          message: userMessage(e, 'Try again.', 'edit captions'),
        });
      })
      .finally(() => countCaptionWrites(values.keys(), -1));
  };

  /** Delete a clip; resolves whether it was deleted (a failure is shown). */
  const remove = async (id: string): Promise<boolean> => {
    try {
      dropClipJobs({ segmentIds: [id] });
      await deleteSegment(id);
      return true;
    } catch (e) {
      showToast({
        kind: 'error',
        title: 'Couldn’t delete the clip',
        message: userMessage(e, 'Try again.', 'delete clip'),
      });
      return false;
    }
  };

  return {
    /** False until the rows are first read (or the read failed). */
    loaded: updatedAt !== undefined || error !== undefined,
    clips,
    /** The clips' rows as they play now (pending edits applied), for the captions. */
    segments,
    covers,
    /** Each clip's edited captions (`segments.caption_edit`), by id. */
    captionEdits,
    options,
    setEdit,
    /** Store a raw value (undo/redo): an edit string, or null to reset. */
    setValue: write,
    reorder,
    remove,
    setCaptions,
  };
}
