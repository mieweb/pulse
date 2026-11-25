import type { SplitReceipt, TakenOutClips } from '@/db/drafts';

export type Snapshot = {
  order: string[];
  edits: Record<string, string | null>;
  captions: Record<string, string | null>;
  captionY: number | null;
};

export type AddedStep = {
  kind: 'added';
  ids: string[];
  taken: TakenOutClips | null;
  /** Original clips changed by this addition, restored together with taking its clips out. */
  splits?: readonly SplitReceipt[];
  /** An image batch extends this same chronological step while its remaining media prepares. */
  batchKey?: string;
};

export type Step = { kind: 'state'; snapshot: Snapshot } | AddedStep;

/** What the clips are now, as far as a step can change them. */
export type Present = {
  clips: readonly { id: string; editKey: string | null }[];
  captions: ReadonlyMap<string, string | null>;
  captionY: number | null;
};

/** The writes that bring the draft back to a snapshot; empty when it already matches. */
export type SnapshotDiff = {
  edits: [string, string | null][];
  captions: Map<string, string | null>;
  /** Undefined: leave where the captions sit. */
  captionY?: number | null;
  /** The full order to store, or null when it stays. */
  order: string[] | null;
};
