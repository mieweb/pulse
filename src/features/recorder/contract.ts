// What a shell gives the recorder and what it hears back. The standalone app maps these to router
// pushes (src/app/recorder.tsx); the embed shell maps them to its own flow. The screen itself never
// navigates.
import type { DraftContext } from '@/db/drafts';
import type { HostContext } from '@/db/host-context';

/** What a draft this recorder creates starts with (read once, on mount). */
export type RecorderNewDraft = {
  /** The draft's name, e.g. a link's or a host place's label; null for the default name. */
  name: string | null;
  /** The place the draft is recorded for; null for none. */
  context: DraftContext | null;
  /**
   * Embedded: the host place the flow records for (its `PulseContext`, with the upload type). A
   * draft made here stores it, and the recorder shows its banner. Absent in the Pulse app.
   */
  hostContext?: HostContext | null;
  /** Which shell makes the draft (`createDraft`'s `createdVia`); default 'app'. */
  createdVia?: 'app' | 'host';
};

/** How the recorder was left. */
export type RecorderCloseResult = {
  /**
   * The draft this recorder worked on, or null when it never made one. An in-flight take is saved
   * into it before `onClose` runs. A draft left with no clips is dropped as the recorder unmounts.
   */
  draftId: string | null;
};

export type RecorderScreenProps = {
  /** An existing draft to add clips to; without it the first take creates one from `newDraft`. */
  draftId?: string;
  newDraft: RecorderNewDraft;
  /**
   * Open the editor on the draft, on `clipId` when a clip in the bar was tapped. Called after
   * pending edits are stored, and once per tap until the recorder is focused again.
   */
  onEdit: (draftId: string, clipId?: string) => void;
  /** Open Export for the draft; same timing as `onEdit`. */
  onExport: (draftId: string) => void;
  /** Leave the recorder (its ✕, after the take in flight is saved). */
  onClose: (result: RecorderCloseResult) => void;
};
