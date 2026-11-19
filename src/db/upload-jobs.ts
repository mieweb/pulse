import { eq, inArray } from 'drizzle-orm';

import { db } from './client';
import { uploadJobs, type UploadJob } from './schema';

// The embedded upload outbox (`upload_jobs`, LOCAL): one row per draft that was sent and hasn't
// retired. Its `state` is the only persisted upload state an embedded draft has (AD33); the
// transitions between states are the outbox's (features/upload/core/outbox.ts), which writes
// through the helpers here inside one synchronous transaction.

export type JobState = UploadJob['state'];
export type { UploadJob };

/**
 * The states that lock a draft: `edit`, `deleteDraft`, `setDraftContext` and `cancelUpload` refuse
 * with `draft.locked` while its job is in one (PLAN §6.1). Merging, sending bytes, or waiting for
 * the server's outcome: the draft goes up exactly as it was at Send.
 */
export const LOCKED_JOB_STATES = ['preparing', 'uploading', 'delivering'] as const;

/** Whether a job in `state` locks its draft. */
export function isLockedJobState(state: JobState): boolean {
  return (LOCKED_JOB_STATES as readonly JobState[]).includes(state);
}

/**
 * One file a job sends (pulse-schema.md §3.2), in the order they go: captions, manifest and
 * thumbnail (each `relatedTo` the video), then the video last. `file` is relative to the
 * namespace's documents root. The video's `artifactId` is null until the host's upload target
 * names it (the related parts have their own from PREPARING on).
 */
export type UploadPart = {
  role: 'captions' | 'manifest' | 'thumbnail' | 'video';
  artifactId: string | null;
  file: string;
  bytes: number;
  /** The TUS upload's URL once created: HEAD it for the offset to resume from. */
  tusUrl: string | null;
  done: boolean;
};

const ROLES: readonly UploadPart['role'][] = ['captions', 'manifest', 'thumbnail', 'video'];

function isPart(v: unknown): v is UploadPart {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    ROLES.includes(p.role as UploadPart['role']) &&
    (p.artifactId === null || typeof p.artifactId === 'string') &&
    typeof p.file === 'string' &&
    typeof p.bytes === 'number' &&
    (p.tusUrl === null || typeof p.tusUrl === 'string') &&
    typeof p.done === 'boolean'
  );
}

/** A job's `parts_json`, read back; empty when unset or unreadable (PREPARING writes it again). */
export function parseParts(json: string | null | undefined): UploadPart[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) && parsed.every(isPart) ? parsed : [];
  } catch {
    return [];
  }
}

export function serializeParts(parts: readonly UploadPart[]): string {
  return JSON.stringify(parts);
}

/** A transaction handle, as `db.transaction` passes it (writes run synchronously in it). */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The draft's job, or null, read inside `tx`. */
export function readJob(tx: Tx, draftId: string): UploadJob | null {
  return tx.select().from(uploadJobs).where(eq(uploadJobs.draftId, draftId)).get() ?? null;
}

/** The draft's job, or null. */
export function getUploadJob(draftId: string): UploadJob | null {
  return db.select().from(uploadJobs).where(eq(uploadJobs.draftId, draftId)).get() ?? null;
}

/** Every job, or those in `states`, oldest Send first. */
export function listUploadJobs(states?: readonly JobState[]): UploadJob[] {
  const query = db.select().from(uploadJobs);
  const rows = states ? query.where(inArray(uploadJobs.state, [...states])).all() : query.all();
  return rows.sort((a, b) => a.sentAt - b.sentAt || a.createdAt - b.createdAt);
}

// Change notices --------------------------------------------------------------------------------

const listeners = new Set<(draftIds: readonly string[]) => void>();

/**
 * Calls `listener` with the drafts whose job changed, after each committed outbox write: what the
 * catalog writer and the `draftsChanged` event follow. Returns the unsubscribe.
 */
export function subscribeUploadJobs(listener: (draftIds: readonly string[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tell the subscribers that these drafts' jobs changed (call after the commit). */
export function notifyUploadJobs(draftIds: readonly string[]): void {
  if (draftIds.length === 0) return;
  for (const listener of [...listeners]) {
    try {
      listener(draftIds);
    } catch (e) {
      console.warn('[upload-jobs] a listener failed', e);
    }
  }
}
