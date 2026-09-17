import type { File } from 'expo-file-system';

import type { Segment } from '@/db/schema';

import type { ArtifactKind } from './tus-client';

/**
 * A paired upload destination resolved for a draft. The bearer `token` lives in
 * expo-secure-store (not the drizzle row); it's carried on the session so the
 * manager can upload without a re-fetch. `directUpload` was decided when the
 * link was paired (capabilities are probed once, at scan time).
 */
export type Destination = {
  server: string;
  token: string | null;
  artifactId: string;
  directUpload: boolean;
};

/** The merged export output an upload session sends (from `useExport`). */
export type MergedOutput = { path: string; durationMs: number };

/**
 * One upload run for a draft. Captured at enqueue time — while the export
 * screen is foreground and the merge is done — and held in-memory by the
 * manager. Deliberately NOT persisted: pairings are single-shot, so an app
 * kill doesn't resume the run; the launch sweep settles the draft instead.
 */
export type UploadSession = {
  draftId: string;
  destination: Destination;
  segments: Segment[];
  /** The merged export this session uploads. */
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
 * Held in-memory (progress ticks are high-frequency and never persisted).
 * There is no error state: failure is an EVENT (toast + notification), after
 * which the draft is simply idle/unpaired again.
 */
export type LiveUploadState =
  | { status: 'idle' }
  | {
      status: 'uploading';
      phase: UploadPhase;
      progress: number;
    }
  | { status: 'done'; resourceUrl: string };

/** One artifact to hand a transport — a session anchor (video/manifest) or a related sub-artifact. */
export type UploadArtifactSpec = {
  artifactId: string;
  filename: string;
  kind: ArtifactKind;
  relatedTo?: string;
  checksum?: string;
  /** Free-form display title (the draft name). Set only on the session anchor. */
  name?: string;
  file: File;
};

/**
 * Uploads a single artifact to its destination. The framework-agnostic seam the
 * background manager drives — TUS by default, the presigned direct profile when
 * the pairing advertised it. Every run creates fresh: identities are single-shot,
 * so there is no resume input.
 */
export type UploadTransport = {
  run(params: {
    destination: Destination;
    artifact: UploadArtifactSpec;
    signal: AbortSignal;
    onProgress?: (progress: UploadProgress) => void;
    /** Fired as soon as the resource URL is known, so the caller can track what's in flight (the cancel handle). */
    onResourceCreated?: (resourceUrl: string) => void | Promise<void>;
  }): Promise<{ resourceUrl: string }>;
  /** Server-side cancel (bearer DELETE) of an in-flight resource. */
  cancel(resourceUrl: string, token: string | null): Promise<void>;
};
