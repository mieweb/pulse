import { asc, count, eq, gte, sql } from 'drizzle-orm';

import { db } from './client';
import {
  clipTranscripts,
  drafts,
  segments,
  uploadJobs,
  uploadReceipts,
  type Segment,
  type UploadJob,
  type UploadReceipt,
} from './schema';

// What the embed's catalog (features/drafts/catalog.ts) is projected from: every draft with its
// clip count, duration and cover as `draftListQuery` reads them, the clips themselves (whether the
// export is current, whether there are captions), the outbox and the unexpired receipts. Read in
// one transaction, so the catalog never mixes a draft from before a write with its job from after.

/** A draft row as the catalog needs it: its columns, and its clips summed as Home sums them. */
export type CatalogDraftRow = {
  id: string;
  name: string | null;
  contextKey: string | null;
  contextLabel: string | null;
  contextJson: string | null;
  uploadTypeJson: string | null;
  createdVia: 'app' | 'host';
  createdAt: number;
  lastModified: number;
  mergedSignature: string | null;
  mergedDurationMs: number | null;
  hostConfirmedAt: number | null;
  clipCount: number;
  durationMs: number;
  /** The first clip's persisted cover (relative path), as Home's draft card shows it. */
  coverThumbnail: string | null;
};

/** A clip transcript row for the captions model in use. */
export type CatalogTranscriptRow = {
  segmentId: string;
  file: string;
  status: string;
  words: string | null;
};

export type CatalogRows = {
  drafts: CatalogDraftRow[];
  /** Every clip, by draft and then in timeline order. */
  segments: Segment[];
  /** The clip transcripts of `captionModel` (none without a model). */
  transcripts: CatalogTranscriptRow[];
  jobs: UploadJob[];
  /** Receipts that haven't expired at `now`. */
  receipts: UploadReceipt[];
};

/**
 * One consistent read of everything the catalog shows. `captionModel` is the captions model in use
 * (resolved by the caller, which knows the platform), or null for none. The clip count, duration
 * and cover are computed with the same SQL as `draftListQuery` (drafts.ts), so the catalog and
 * Home agree on them.
 */
export function readCatalogRows(now: number, captionModel: string | null): CatalogRows {
  return db.transaction((tx) => ({
    drafts: tx
      .select({
        id: drafts.id,
        name: drafts.name,
        contextKey: drafts.contextKey,
        contextLabel: drafts.contextLabel,
        contextJson: drafts.contextJson,
        uploadTypeJson: drafts.uploadTypeJson,
        createdVia: drafts.createdVia,
        createdAt: drafts.createdAt,
        lastModified: drafts.lastModified,
        mergedSignature: drafts.mergedSignature,
        mergedDurationMs: drafts.mergedDurationMs,
        hostConfirmedAt: drafts.hostConfirmedAt,
        clipCount: count(segments.id),
        durationMs: sql<number>`coalesce(sum(coalesce(${segments.editedDurationMs}, ${segments.durationMs})), 0)`,
        coverThumbnail: sql<
          string | null
        >`(select thumbnail from ${segments} where ${segments.draftId} = ${drafts.id} order by sort_order limit 1)`,
      })
      .from(drafts)
      .leftJoin(segments, eq(segments.draftId, drafts.id))
      .groupBy(drafts.id)
      .all(),
    segments: tx.select().from(segments).orderBy(asc(segments.draftId), asc(segments.order)).all(),
    transcripts:
      captionModel == null
        ? []
        : tx
            .select({
              segmentId: clipTranscripts.segmentId,
              file: clipTranscripts.file,
              status: clipTranscripts.status,
              words: clipTranscripts.words,
            })
            .from(clipTranscripts)
            .where(eq(clipTranscripts.model, captionModel))
            .all(),
    jobs: tx.select().from(uploadJobs).all(),
    receipts: tx.select().from(uploadReceipts).where(gte(uploadReceipts.expiresAt, now)).all(),
  }));
}
