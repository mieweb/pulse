import type { PairedDestination } from '@/db/destinations';
import type { Segment } from '@/db/schema';

/**
 * The pairing a draft uploads under: the pool destination it claimed. The bearer
 * `token` lives in expo-secure-store (not the drizzle row); it's carried on the
 * session so the manager can upload without a re-fetch.
 */
export type Destination = PairedDestination;

/** The video a session uploads: the draft's persisted export (`drafts/{id}/export.mp4`). */
export type MergedOutput = { path: string; durationMs: number };

/**
 * One upload run for a draft. Captured at claim time — while the export screen is
 * foreground and the merge is done — and held in memory only: the upload lives as
 * long as the app does. After a kill there is nothing to resume from; the next
 * launch fails the draft instead.
 */
export type UploadSession = {
  draftId: string;
  destination: Destination;
  segments: Segment[];
  merged: MergedOutput;
};

export type UploadProgress = { bytesSent: number; totalBytes: number };

/**
 * What an in-flight upload is actually doing. A run spends real time before (and
 * between) byte transfers — preparing the export and building/uploading the small
 * related artifacts — and each of those used to render as an indistinguishable
 * `Uploading… 0%`. Only `video` carries meaningful byte progress; the rest are
 * label-only.
 */
export type UploadPhase = 'preparing' | 'captions' | 'manifest' | 'thumbnail' | 'video';

/**
 * Live, per-draft upload state the UI subscribes to via `useSyncExternalStore`.
 * Held in-memory (progress ticks are high-frequency and never persisted). Finishing
 * and failing are events (a toast, or a notification in the background), after
 * which the draft is idle again — uploaded (with a watch link, see `getWatchLink`)
 * or unpaired.
 */
export type LiveUploadState =
  { status: 'idle' } | { status: 'uploading'; phase: UploadPhase; progress: number };
