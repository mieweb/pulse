import { useSyncExternalStore } from 'react';

import { deleteDraft, deleteSegment, segmentsForDraft } from '@/db/drafts';

/**
 * Optimistic clip deletes. A deleted clip is hidden at once and its row and files stay put while
 * the Undo toast is up; the real delete runs when the toast commits. Nothing is removed from disk
 * until then, so Undo is just "show it again": the row never left, so the clip comes back in its
 * original slot.
 *
 * Module state, not a recorder's: the toast outlives the recorder (closing it leaves the toast up
 * over Home), and a recorder reopened on the same draft before the toast commits must keep the
 * clip hidden too.
 */

type Pending = {
  draftId: string;
  committed: boolean;
  /** The clip's length, so Home can leave it out of the draft's total while it's pending. */
  durationMs: number;
  closeToast?: () => void;
};

/** Per draft, the clips waiting on their Undo: how many, and how long they run together. */
export type PendingByDraft = ReadonlyMap<string, { count: number; durationMs: number }>;

const pending = new Map<string, Pending>();
// Committed ids stay hidden for good: the row is gone a moment later, but the live query only
// re-runs after the delete lands, and un-hiding before that would flash the clip back.
let hidden: ReadonlySet<string> = new Set();
let byDraft: PendingByDraft = new Map();
const listeners = new Set<() => void>();
// Recorders mounted per draft. A delete that commits after its recorder closed also drops the
// draft if that left it empty, which the recorder's own leave-cleanup can no longer do.
const openDrafts = new Map<string, number>();

function publish(next: Set<string> = new Set(hidden)) {
  hidden = next;
  // Only deletes still waiting: once one is committed its row leaves the db, and Home's counts
  // drop on their own.
  const counts = new Map<string, { count: number; durationMs: number }>();
  for (const p of pending.values()) {
    if (p.committed) continue;
    const c = counts.get(p.draftId) ?? { count: 0, durationMs: 0 };
    counts.set(p.draftId, { count: c.count + 1, durationMs: c.durationMs + p.durationMs });
  }
  byDraft = counts;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The ids of clips deleted but not yet (or just) committed — filter them out of the draft. */
export function useHiddenClips(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => hidden);
}

/** Per draft, the clips hidden while their Undo is up (Home subtracts them from its cards). */
export function usePendingClipDeletes(): PendingByDraft {
  return useSyncExternalStore(subscribe, () => byDraft);
}

/** Hide a clip now; `commitClipDelete` or `restoreClip` settles it. */
export function hideClip(id: string, draftId: string, durationMs: number) {
  pending.set(id, { draftId, committed: false, durationMs });
  publish(new Set(hidden).add(id));
}

/** The clip's Undo toast closer, so committing early (`commitDraftDeletes`) also takes it down. */
export function setClipToastCloser(id: string, closeToast: () => void) {
  const entry = pending.get(id);
  if (entry) entry.closeToast = closeToast;
}

/** Undo: show the clip again. False when it was already deleted for real (see `commitDraftDeletes`). */
export function restoreClip(id: string): boolean {
  const entry = pending.get(id);
  if (!entry || entry.committed) return false;
  pending.delete(id);
  const next = new Set(hidden);
  next.delete(id);
  publish(next);
  return true;
}

/** Delete the clip for real. On failure the clip is shown again and the error rethrown. */
export async function commitClipDelete(id: string): Promise<void> {
  const entry = pending.get(id);
  if (!entry || entry.committed) return;
  entry.committed = true;
  try {
    await deleteSegment(id);
  } catch (e) {
    entry.committed = false;
    restoreClip(id);
    throw e;
  }
  pending.delete(id);
  // The row is gone, so Home's own count already leaves it out: stop subtracting it. (The id
  // stays in `hidden`, see above.)
  publish();
  if (openDrafts.has(entry.draftId)) return;
  try {
    const rest = await segmentsForDraft(entry.draftId);
    if (rest.length === 0) await deleteDraft(entry.draftId);
  } catch {
    // An uploading draft can't be deleted (it can't be empty either); a leftover empty draft is
    // harmless.
  }
}

/** Commit every pending delete in a draft now, before something reads the draft from the db. */
export async function commitDraftDeletes(draftId: string): Promise<void> {
  const entries = [...pending].filter(([, p]) => p.draftId === draftId && !p.committed);
  // Start the deletes first, then close their toasts: a closed toast commits too, and finding
  // the delete already under way it does nothing, so no Undo stays up that can't undo.
  const commits = entries.map(([id]) => commitClipDelete(id));
  for (const [, entry] of entries) entry.closeToast?.();
  await Promise.all(commits);
}

/** Marks a draft open in a recorder while the returned cleanup hasn't run. */
export function markDraftOpen(draftId: string): () => void {
  openDrafts.set(draftId, (openDrafts.get(draftId) ?? 0) + 1);
  return () => {
    const n = (openDrafts.get(draftId) ?? 1) - 1;
    if (n > 0) openDrafts.set(draftId, n);
    else openDrafts.delete(draftId);
  };
}
