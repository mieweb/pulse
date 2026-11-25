import type { SplitReceipt, TakenOutClips } from '@/db/drafts';
import type { ClipTranscript, Segment } from '@/db/schema';
import { editedThumbRelPath, thumbRelPath } from '@/utils/media-paths';

import type { Snapshot, Step } from '@/core/types/editor-history';

/** Versioned data only: coalescing windows and in-flight operations never survive a checkpoint. */
export type PersistedHistory = {
  version: 1;
  checkpoint: string;
  past: Step[];
  future: Step[];
};

export const HISTORY_MAX_STEPS = 100;
export const HISTORY_MAX_MEDIA_BYTES = 256 * 1024 * 1024;
export const HISTORY_MAX_JSON_BYTES = 2 * 1024 * 1024;

const BAD_HISTORY = 'The saved Undo history is damaged or unsupported.';
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const isId = (value: unknown): value is string =>
  typeof value === 'string' &&
  idPattern.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const integer = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isId) && new Set(value).size === value.length;
const safePath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('drafts/') &&
  !value.includes('\\') &&
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');

/** UTF-8 size without relying on a browser-only TextEncoder in React Native. */
function byteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function captionFile(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!object(parsed) || !('file' in parsed)) return null;
    if (!safePath(parsed.file)) throw new Error(BAD_HISTORY);
    return parsed.file;
  } catch (error) {
    // Older caption values can contain unreadable text. Preserve it, as live rows do, but a
    // parsed file reference must be safe before it can ever reach file cleanup or an import.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function validCaption(value: unknown): boolean {
  if (!nullableString(value)) return false;
  captionFile(value as string | null);
  return true;
}

function validSnapshot(value: unknown): value is Snapshot {
  if (!object(value) || !keys(value, ['order', 'edits', 'captions', 'captionY'])) return false;
  if (!ids(value.order) || !object(value.edits) || !object(value.captions)) return false;
  const order = new Set(value.order);
  return (
    (value.captionY === null ||
      (finite(value.captionY) && value.captionY >= 0 && value.captionY <= 1)) &&
    Object.keys(value.edits).length === order.size &&
    Object.keys(value.captions).length === order.size &&
    Object.entries(value.edits).every(([id, edit]) => order.has(id) && nullableString(edit)) &&
    Object.entries(value.captions).every(([id, caption]) => order.has(id) && validCaption(caption))
  );
}

function validRow(value: unknown, draftId: string): value is Segment {
  if (
    !object(value) ||
    !keys(value, [
      'id',
      'draftId',
      'order',
      'label',
      'originalFilename',
      'durationMs',
      'editedFilename',
      'editedDurationMs',
      'editState',
      'thumbnail',
      'captionEdit',
    ])
  )
    return false;
  return (
    isId(value.id) &&
    value.draftId === draftId &&
    integer(value.order) &&
    value.order >= 0 &&
    nullableString(value.label) &&
    safePath(value.originalFilename) &&
    finite(value.durationMs) &&
    value.durationMs >= 0 &&
    (value.editedFilename === null || safePath(value.editedFilename)) &&
    (value.editedDurationMs === null ||
      (finite(value.editedDurationMs) && value.editedDurationMs >= 0)) &&
    nullableString(value.editState) &&
    (value.thumbnail === null || safePath(value.thumbnail)) &&
    validCaption(value.captionEdit)
  );
}

function validTranscript(value: unknown, rowIds: Set<string>): value is ClipTranscript {
  return (
    object(value) &&
    keys(value, ['segmentId', 'model', 'file', 'status', 'words', 'createdAt']) &&
    isId(value.segmentId) &&
    rowIds.has(value.segmentId) &&
    typeof value.model === 'string' &&
    value.model.length > 0 &&
    safePath(value.file) &&
    (value.status === 'done' || value.status === 'error') &&
    nullableString(value.words) &&
    finite(value.createdAt) &&
    value.createdAt >= 0
  );
}

function validTaken(value: unknown, draftId: string): value is TakenOutClips {
  if (
    !object(value) ||
    !keys(value, ['draftId', 'order', 'rows', 'transcripts', 'replaced']) ||
    value.draftId !== draftId ||
    !ids(value.order) ||
    !Array.isArray(value.rows) ||
    !value.rows.every((row) => validRow(row, draftId)) ||
    !Array.isArray(value.transcripts)
  )
    return false;
  const rowIds = new Set(value.rows.map((row) => row.id));
  const order = value.order;
  if (rowIds.size !== value.rows.length || !value.rows.every((row) => order.includes(row.id)))
    return false;
  if (!value.transcripts.every((row) => validTranscript(row, rowIds))) return false;
  const transcriptKeys = value.transcripts.map((row) => JSON.stringify([row.segmentId, row.model]));
  if (new Set(transcriptKeys).size !== transcriptKeys.length) return false;
  if (value.replaced !== undefined) {
    if (!Array.isArray(value.replaced) || !value.replaced.every((row) => validRow(row, draftId)))
      return false;
    if (new Set(value.replaced.map((row) => row.id)).size !== value.replaced.length) return false;
  }
  return true;
}

function validSplit(value: unknown, draftId: string): value is SplitReceipt {
  return (
    object(value) &&
    keys(value, ['before', 'rightId', 'firstInsertedId']) &&
    validTaken(value.before, draftId) &&
    isId(value.rightId) &&
    (value.firstInsertedId === undefined ||
      (isId(value.firstInsertedId) && value.rightId !== value.firstInsertedId)) &&
    value.before.rows.length > 0 &&
    !value.before.rows.some((row) => row.id === value.rightId || row.id === value.firstInsertedId)
  );
}

function validStep(value: unknown, draftId: string, direction: 'past' | 'future'): value is Step {
  if (!object(value)) return false;
  if (value.kind === 'state')
    return keys(value, ['kind', 'snapshot']) && validSnapshot(value.snapshot);
  return (
    value.kind === 'added' &&
    keys(value, ['kind', 'ids', 'taken', 'splits', 'batchKey']) &&
    ids(value.ids) &&
    (direction === 'past' ? value.taken === null : validTaken(value.taken, draftId)) &&
    (value.splits === undefined ||
      (Array.isArray(value.splits) && value.splits.every((split) => validSplit(split, draftId)))) &&
    (value.batchKey === undefined || typeof value.batchKey === 'string')
  );
}

/** Null is an older draft with no history. Invalid non-null data is never partly hydrated. */
export function parsePersistedHistory(
  value: string | null | undefined,
  draftId: string,
): PersistedHistory | null {
  if (value == null) return null;
  if (!isId(draftId) || typeof value !== 'string' || byteLength(value) > HISTORY_MAX_JSON_BYTES)
    throw new Error(BAD_HISTORY);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(BAD_HISTORY);
  }
  if (
    !object(parsed) ||
    !keys(parsed, ['version', 'checkpoint', 'past', 'future']) ||
    parsed.version !== 1 ||
    typeof parsed.checkpoint !== 'string' ||
    !Array.isArray(parsed.past) ||
    !Array.isArray(parsed.future) ||
    parsed.past.length + parsed.future.length > HISTORY_MAX_STEPS ||
    !parsed.past.every((step) => validStep(step, draftId, 'past')) ||
    !parsed.future.every((step) => validStep(step, draftId, 'future'))
  )
    throw new Error(BAD_HISTORY);
  return parsed as PersistedHistory;
}

function takenFrom(step: Step): TakenOutClips[] {
  return step.kind === 'added'
    ? [...(step.taken ? [step.taken] : []), ...(step.splits ?? []).map((split) => split.before)]
    : [];
}

/** All IDs, including snapshot-only and dormant IDs that have no live segment row. */
export function historyClipIds(history: PersistedHistory): Set<string> {
  const out = new Set<string>();
  for (const step of [...history.past, ...history.future]) {
    if (step.kind === 'state') {
      step.snapshot.order.forEach((id) => out.add(id));
      Object.keys(step.snapshot.edits).forEach((id) => out.add(id));
      Object.keys(step.snapshot.captions).forEach((id) => out.add(id));
    } else {
      step.ids.forEach((id) => out.add(id));
      for (const split of step.splits ?? []) {
        out.add(split.rightId);
        if (split.firstInsertedId !== undefined) out.add(split.firstInsertedId);
      }
      for (const taken of takenFrom(step)) {
        taken.order.forEach((id) => out.add(id));
        [...taken.rows, ...(taken.replaced ?? [])].forEach((row) => out.add(row.id));
        taken.transcripts.forEach((row) => out.add(row.segmentId));
      }
    }
  }
  return out;
}

/** Dormant row identities claim ownership too, before Redo brings them back into segments. */
export function historyOwnedClipIds(history: PersistedHistory): Set<string> {
  return new Set(
    [...history.past, ...history.future].flatMap((step) =>
      takenFrom(step).flatMap((taken) =>
        [...taken.rows, ...(taken.replaced ?? [])].map((row) => row.id),
      ),
    ),
  );
}

/** Deleted snapshot-only IDs are valid; IDs owned by another draft can never be replayed here. */
export function assertHistoryOwnership(
  history: PersistedHistory,
  draftId: string,
  owners: ReadonlyMap<string, string>,
): void {
  for (const id of historyClipIds(history)) {
    const owner = owners.get(id);
    if (owner !== undefined && owner !== draftId) throw new Error(BAD_HISTORY);
  }
}

/** Files actually needed to replay a step; thumbnails are regenerable and aren't required. */
function requiredPaths(step: Step): Set<string> {
  const out = new Set<string>();
  const caption = (value: string | null) => {
    const file = captionFile(value);
    if (file) out.add(file);
  };
  if (step.kind === 'state') Object.values(step.snapshot.captions).forEach(caption);
  for (const taken of takenFrom(step)) {
    for (const row of [...taken.rows, ...(taken.replaced ?? [])]) {
      out.add(row.originalFilename);
      if (row.editedFilename) out.add(row.editedFilename);
      caption(row.captionEdit);
    }
    taken.transcripts.forEach((row) => out.add(row.file));
  }
  return out;
}

/** Sources needed for replay, excluding optional thumbnails that can be regenerated. */
export function requiredHistoryMediaPaths(history: PersistedHistory): Set<string> {
  return new Set([...history.past, ...history.future].flatMap((step) => [...requiredPaths(step)]));
}

/** Every reference, also covering pristine/baked thumbnails of dormant clips. */
export function historyMediaPaths(history: PersistedHistory): Set<string> {
  const out = new Set<string>();
  for (const step of [...history.past, ...history.future]) {
    requiredPaths(step).forEach((path) => out.add(path));
    for (const taken of takenFrom(step)) {
      for (const row of [...taken.rows, ...(taken.replaced ?? [])]) {
        out.add(thumbRelPath(row.draftId, row.id));
        if (row.thumbnail) out.add(row.thumbnail);
        if (row.editedFilename) out.add(editedThumbRelPath(row.editedFilename));
      }
    }
  }
  return out;
}

/** Copy every nested identity and file reference. Batch keys are only meaningful in an open UI. */
export function remapPersistedHistory(
  history: PersistedHistory,
  remap: {
    draftId: string;
    mapId: (id: string) => string;
    mapPath: (path: string) => string;
    checkpoint?: string;
  },
): PersistedHistory {
  const { mapId, mapPath } = remap;
  const caption = (value: string | null) => {
    if (value === null || !captionFile(value)) return value;
    return JSON.stringify({ ...JSON.parse(value), file: mapPath(captionFile(value)!) });
  };
  const row = (value: Segment): Segment => ({
    ...value,
    id: mapId(value.id),
    draftId: remap.draftId,
    originalFilename: mapPath(value.originalFilename),
    editedFilename: value.editedFilename === null ? null : mapPath(value.editedFilename),
    thumbnail: value.thumbnail === null ? null : mapPath(value.thumbnail),
    captionEdit: caption(value.captionEdit),
  });
  const taken = (value: TakenOutClips): TakenOutClips => ({
    ...value,
    draftId: remap.draftId,
    order: value.order.map(mapId),
    rows: value.rows.map(row),
    transcripts: value.transcripts.map((transcript) => ({
      ...transcript,
      segmentId: mapId(transcript.segmentId),
      file: mapPath(transcript.file),
    })),
    ...(value.replaced ? { replaced: value.replaced.map(row) } : {}),
  });
  const step = (value: Step): Step =>
    value.kind === 'state'
      ? {
          kind: 'state',
          snapshot: {
            ...value.snapshot,
            order: value.snapshot.order.map(mapId),
            edits: Object.fromEntries(
              Object.entries(value.snapshot.edits).map(([id, edit]) => [mapId(id), edit]),
            ),
            captions: Object.fromEntries(
              Object.entries(value.snapshot.captions).map(([id, value]) => [
                mapId(id),
                caption(value),
              ]),
            ),
          },
        }
      : {
          kind: 'added',
          ids: value.ids.map(mapId),
          taken: value.taken ? taken(value.taken) : null,
          ...(value.splits
            ? {
                splits: value.splits.map((split) => ({
                  before: taken(split.before),
                  rightId: mapId(split.rightId),
                  ...(split.firstInsertedId !== undefined
                    ? { firstInsertedId: mapId(split.firstInsertedId) }
                    : {}),
                })),
              }
            : {}),
        };
  return {
    version: 1,
    checkpoint: remap.checkpoint ?? history.checkpoint,
    past: history.past.map(step),
    future: history.future.map(step),
  };
}

/**
 * Retain a contiguous chain nearest the present on each stack, bounded by steps, JSON and unique
 * history-only media bytes. A missing source drops its step and every farther step on that stack.
 * Eviction starts with the oldest Undo, then the farthest Redo; it never deletes a file itself.
 */
export function trimPersistedHistory(
  history: PersistedHistory,
  sizeOf: (path: string) => number | null,
  livePaths: ReadonlySet<string> = new Set(),
): PersistedHistory {
  const sizes = new Map<string, number | null>();
  const size = (path: string) => {
    if (!sizes.has(path)) {
      const measured = sizeOf(path);
      sizes.set(
        path,
        measured !== null && Number.isFinite(measured) && measured >= 0 ? measured : null,
      );
    }
    return sizes.get(path)!;
  };
  const usable = (stack: Step[]) => {
    let from = 0;
    stack.forEach((step, index) => {
      if ([...requiredPaths(step)].some((path) => size(path) === null)) from = index + 1;
    });
    return stack.slice(from);
  };
  const out: PersistedHistory = {
    ...history,
    past: usable(history.past),
    future: usable(history.future),
  };
  const tooLarge = () => {
    if (out.past.length + out.future.length > HISTORY_MAX_STEPS) return true;
    if (byteLength(JSON.stringify(out)) > HISTORY_MAX_JSON_BYTES) return true;
    let total = 0;
    for (const path of historyMediaPaths(out)) {
      if (livePaths.has(path)) continue;
      total += Math.max(0, size(path) ?? 0);
      if (total > HISTORY_MAX_MEDIA_BYTES) return true;
    }
    return false;
  };
  while ((out.past.length || out.future.length) && tooLarge()) {
    if (out.past.length) out.past = out.past.slice(1);
    else out.future = out.future.slice(1);
  }
  return out;
}
