import { currentExportDuration, type ExportAudio } from '@/core/media/merge-signature';
import type { CatalogRows, CatalogTranscriptRow } from '@/db/catalog-queries';
import { clipWordsOf } from '@/db/clip-transcripts';
import { draftDisplayName } from '@/db/drafts';
import { hostContextOf } from '@/db/host-context';
import type { Segment, UploadJob, UploadReceipt } from '@/db/schema';
import { composeCaptions } from '@/features/transcription/compose';
import { effMs } from '@/utils/segment-window';
import { exportRelPath } from '@/utils/media-paths';

import { catalogOrder } from './catalog-filter';

// The embed's catalog (native-bridge.md §6.1, pulse-schema.md §5): the library as the host sees
// it, projected from SQLite. This is the one place rows become a draft's state and summary; the
// catalog writer and the tests use it, and PulseKit answers listDrafts / getDraft / countDrafts
// from the file it writes.
//
// The types mirror DraftSummary and its parts in @mieweb/pulse-embed (embed/packages/pulse-embed
// src/types.ts), which shared code can't import (the embed boundary, eslint.config.js).

/** A draft's state as the host sees it (`DraftState`). */
export type DraftState =
  | 'draft'
  | 'ready'
  | 'preparing'
  | 'queued'
  | 'waiting_network'
  | 'uploading'
  | 'delivering'
  | 'needs_credentials'
  | 'failed'
  | 'sent';

/** A file in the namespace (`FileRef`). The facade's adapter fills `webUrl`. */
export type CatalogFileRef = { rel: string; path: string; webUrl: string; bytes?: number };

/** The host place a draft is for (`PulseContext`), as the host handed it over. */
export type CatalogContext = {
  key: string;
  kind: string;
  id: string;
  label: string;
  uploadType?: unknown;
  data?: unknown;
  [field: string]: unknown;
};

/** A coded error (`PulseErrorInfo`). */
export type CatalogError = {
  code: string;
  message: string;
  recoverable: boolean;
  callId: string;
};

/** The draft's upload (`DraftUpload`). */
export type CatalogUpload = {
  clientKey: string;
  uploadId?: string;
  artifactId?: string;
  progress?: number;
  attempts: number;
  nextAttemptAt?: number;
  sentAt: number;
  error?: CatalogError;
};

/** A sent draft's outcome (`DraftReceipt`). */
export type CatalogReceipt = {
  outcome: 'done' | 'kept';
  note?: string;
  reason?: string;
  uploadId: string;
  artifactId: string;
  sentAt: number;
  at: number;
  expiresAt: number;
  dismissed: boolean;
};

/** One draft or receipt (`DraftSummary`). */
export type CatalogDraft = {
  id: string;
  draftKey: string;
  name: string;
  context: CatalogContext | null;
  state: DraftState;
  clipCount: number;
  durationMs: number;
  bytes?: number;
  hasCaptions: boolean;
  confirmedAt?: number;
  poster: CatalogFileRef | null;
  export?: CatalogFileRef;
  upload?: CatalogUpload;
  sent?: CatalogReceipt;
  createdVia: 'app' | 'host';
  createdAt: number;
  updatedAt: number;
};

/** `catalog.json` (native-bridge.md §6.1). */
export type CatalogFile = {
  format: 'pulse-catalog';
  version: 1;
  namespace: string;
  writtenAt: number;
  /** The library's newest migration (`schemaVersion`), null before the first. */
  dbSchema: number | null;
  /** A newer Pulse migrated the library: it lists, sends and deletes, and refuses edits. */
  readOnly: boolean;
  online: boolean;
  /** Every draft not yet sent, newest change first. Never 'waiting_network' or 'sent'. */
  drafts: CatalogDraft[];
  /** Sent drafts whose receipt hasn't expired, newest change first. */
  receipts: CatalogDraft[];
};

/** Everything `projectCatalog` reads: the rows, and what the library alone can't say. */
export type CatalogInput = {
  rows: CatalogRows;
  /** This install's id (`local_settings`), the first half of every `draftKey`. */
  installationId: string;
  /** The audio layout exports are merged in on this device (`exportAudio`). */
  audio: ExportAudio;
  /** The namespace's documents root, a plain absolute path without a trailing '/'. */
  root: string;
  /** The size of each draft's `export.mp4` that is on disk, by draft id. */
  exportBytes: ReadonlyMap<string, number>;
  /** The captions model in use (`rows.transcripts` are its), or null for none. */
  captionModel: string | null;
};

/** The outbox states, each shown under its own name. */
const JOB_STATES: Record<UploadJob['state'], DraftState> = {
  preparing: 'preparing',
  queued: 'queued',
  uploading: 'uploading',
  delivering: 'delivering',
  needs_credentials: 'needs_credentials',
  failed: 'failed',
};

/**
 * The context the columns hold as the host's `PulseContext`: what it handed over, with `kind` and
 * `id` taken from the key (`kind:id`) when it didn't spell them out. Null without one.
 */
function contextOf(columns: {
  contextKey: string | null;
  contextLabel: string | null;
  contextJson: string | null;
  uploadTypeJson: string | null;
}): CatalogContext | null {
  const context = hostContextOf(columns);
  if (!context) return null;
  const colon = context.key.indexOf(':');
  return {
    ...context,
    kind: typeof context.kind === 'string' ? context.kind : context.key.slice(0, colon),
    id: typeof context.id === 'string' ? context.id : context.key.slice(colon + 1),
  };
}

function fileRef(root: string, rel: string, bytes?: number): CatalogFileRef {
  return { rel, path: `${root}/${rel}`, webUrl: '', ...(bytes !== undefined ? { bytes } : null) };
}

/**
 * Whether the draft's captions would go up with it now: what `getDraftCaptions` sends, composed
 * from its clips, is not empty. With a model in use, a clip not transcribed yet holds them all
 * back; without one, the edited captions are all there is.
 */
function hasCaptions(
  clips: Segment[],
  transcriptOf: ReadonlyMap<string, CatalogTranscriptRow>,
  modelInUse: boolean,
): boolean {
  const placed = clips.filter((s) => effMs(s) > 0);
  const own = placed.flatMap((s) => transcriptOf.get(s.id) ?? []);
  const composed = composeCaptions(placed, clipWordsOf(own));
  const complete = !modelInUse || composed.missing.length === 0;
  return complete && composed.lines.length > 0;
}

function uploadOf(job: UploadJob): CatalogUpload {
  // Absent before the first byte (DraftUpload.progress), so a job that has sent nothing yet
  // reads the same as one that hasn't started.
  const progress =
    job.bytesSent != null && job.bytesSent > 0 && job.bytesTotal != null && job.bytesTotal > 0
      ? Math.min(1, job.bytesSent / job.bytesTotal)
      : undefined;
  return {
    clientKey: job.clientKey,
    ...(job.uploadId != null ? { uploadId: job.uploadId } : null),
    ...(job.artifactId != null ? { artifactId: job.artifactId } : null),
    ...(progress !== undefined ? { progress } : null),
    attempts: job.attempts,
    ...(job.nextAttemptAt != null ? { nextAttemptAt: job.nextAttemptAt } : null),
    sentAt: job.sentAt,
    ...(job.lastErrorCode != null
      ? {
          error: {
            code: job.lastErrorCode,
            message: job.lastErrorMessage ?? '',
            recoverable: job.state !== 'failed',
            callId: '',
          },
        }
      : null),
  };
}

function receiptOf(r: UploadReceipt, installationId: string): CatalogDraft {
  return {
    id: r.draftId,
    draftKey: `${installationId}:${r.draftId}`,
    name: r.name,
    context: contextOf(r),
    state: 'sent',
    clipCount: r.clipCount,
    durationMs: r.durationMs,
    hasCaptions: false, // its media is gone: nothing more goes up
    poster: null,
    sent: {
      outcome: r.outcome,
      ...(r.note != null ? { note: r.note } : null),
      ...(r.reason != null ? { reason: r.reason } : null),
      uploadId: r.uploadId,
      artifactId: r.artifactId,
      sentAt: r.sentAt,
      at: r.deliveredAt,
      expiresAt: r.expiresAt,
      dismissed: r.dismissedAt != null,
    },
    createdVia: 'host', // only the embed sends through the outbox
    createdAt: r.sentAt,
    updatedAt: Math.max(r.deliveredAt, r.dismissedAt ?? 0),
  };
}

/**
 * The catalog's drafts and receipts from the library's rows (pulse-schema.md §5):
 * - no job: `ready` when the export on disk is of exactly these clips in this device's audio
 *   layout (the check `resolveMergedExport` makes before reusing it), else `draft`;
 * - a job: its state, under the same name (`waiting_network` is the reader's, catalog-filter.ts);
 * - a receipt that hasn't expired at `now`: `sent`.
 * Each list is newest change first (`catalogOrder`).
 */
export function projectCatalog(
  input: CatalogInput,
  now: number,
): { drafts: CatalogDraft[]; receipts: CatalogDraft[] } {
  const { rows, installationId, audio, root, exportBytes, captionModel } = input;
  const clipsOf = new Map<string, Segment[]>();
  for (const s of rows.segments) {
    const list = clipsOf.get(s.draftId);
    if (list) list.push(s);
    else clipsOf.set(s.draftId, [s]);
  }
  const jobOf = new Map(rows.jobs.map((j) => [j.draftId, j]));
  const transcriptOf = new Map(rows.transcripts.map((t) => [t.segmentId, t]));

  const drafts = rows.drafts.map((d): CatalogDraft => {
    const clips = clipsOf.get(d.id) ?? [];
    const job = jobOf.get(d.id);
    const bytes = exportBytes.get(d.id);
    const current =
      currentExportDuration(
        {
          fileExists: bytes !== undefined,
          signature: d.mergedSignature,
          durationMs: d.mergedDurationMs,
        },
        clips,
        audio,
      ) != null;
    return {
      id: d.id,
      draftKey: job?.draftKey ?? `${installationId}:${d.id}`,
      name: draftDisplayName(d.name, d.contextLabel),
      context: contextOf(d),
      state: job ? JOB_STATES[job.state] : current ? 'ready' : 'draft',
      clipCount: d.clipCount,
      durationMs: d.durationMs,
      ...(current ? { bytes } : null),
      // Turned off, none go up (getDraftCaptions), whatever the clips hold.
      hasCaptions: !d.captionsOff && hasCaptions(clips, transcriptOf, captionModel != null),
      ...(d.hostConfirmedAt != null ? { confirmedAt: d.hostConfirmedAt } : null),
      poster: d.coverThumbnail ? fileRef(root, d.coverThumbnail) : null,
      ...(current ? { export: fileRef(root, exportRelPath(d.id), bytes) } : null),
      ...(job ? { upload: uploadOf(job) } : null),
      createdVia: d.createdVia,
      createdAt: d.createdAt,
      updatedAt: Math.max(d.lastModified, job?.updatedAt ?? 0),
    };
  });
  const receipts = rows.receipts
    .filter((r) => r.expiresAt >= now)
    .map((r) => receiptOf(r, installationId));
  return { drafts: drafts.sort(catalogOrder), receipts: receipts.sort(catalogOrder) };
}
