// What a shell gives the recorder and what it hears back. The standalone app maps these to router
// pushes (src/app/recorder.tsx); the embed shell maps them to its own flow. The screen itself never
// navigates.
import type { ComponentType } from 'react';

import type { ClipAnchor } from '@/core/clip-anchor';
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

/**
 * Where the recorder's Edit opens the editor: on the clip tapped in the bar (`clipId`), else at the
 * insert cursor (`anchor`), so the editor is where the person was in the recorder (#308).
 */
export type RecorderEditAt = { clipId: string } | { anchor: ClipAnchor };

export type RecorderScreenProps = {
  /** An existing draft to add clips to; without it the first take creates one from `newDraft`. */
  draftId?: string;
  newDraft: RecorderNewDraft;
  /**
   * Open the editor on the draft, `at` the clip tapped in the bar or the insert cursor (Edit). A new
   * editor opens there; an editor the recorder goes back to puts its playhead there
   * (`returnEditorTo` with `editAnchor(at)`). Called after pending edits are stored, and once per
   * tap until the recorder is focused again.
   */
  onEdit: (draftId: string, at: RecorderEditAt) => void;
  /** Open Export for the draft; same timing as `onEdit`. */
  onExport: (draftId: string) => void;
  /** Leave the recorder (its ✕, after the take in flight is saved). */
  onClose: (result: RecorderCloseResult) => void;
  /**
   * Screen recording, from the Pulse app (src/features/screen-capture): with it the "+" offers
   * Record screen and a take's Stop shows here. The embed has none (`npm run check:embed`), and
   * its "+" is the plain import.
   */
  screenCapture?: ScreenCapturePort;
  /**
   * Where the recorder's clips go in the draft at first (its insert cursor, #308): the editor's
   * add position when the editor's "Record a clip here" opened it. Default: the end.
   */
  insertAnchor?: ClipAnchor;
  /** What paired places are called, for drafts named after one ("From another Pulse"). */
  placeLabels?: PlaceLabels;
};

/**
 * What a place in the Pulse app's paired pool is called (`usePlaceLabels`, standalone-only), so a
 * draft recorded for one is listed under that label, as on Home. Live: a new function when the
 * pool changes. The embed has no paired places and passes none (its drafts show their own names).
 */
export type PlaceLabels = (server: string | null, ref: string | null) => string | null;

/** `live`: a screen take of Pulse's own is capturing. `stopping`: Stop asked, file settling. */
export type ScreenPhase = 'idle' | 'live' | 'stopping';

/** A screen take as the recorder sees it (module state, so the same in every recorder). */
export type ScreenCaptureState = {
  phase: ScreenPhase;
  /** When the capture began (wall clock), for the timer; null until it has. */
  began: number | null;
  /** The draft the take, or its import, is for. */
  draftId: string | null;
  /** A screen recording is being converted into a draft. */
  importing: boolean;
  /** That conversion's progress (0–1); null until it reports. */
  progress: number | null;
  /** Record screen was tapped and the capture hasn't begun yet (a hint for the UI only). */
  starting: boolean;
};

/** What the Pulse app's screen recording gives the recorder (`RecorderScreenProps.screenCapture`). */
export type ScreenCapturePort = {
  /** The live state, for `useSyncExternalStore` (see `useScreenTake`). */
  subscribe: (notify: () => void) => () => void;
  getState: () => ScreenCaptureState;
  /** Whether a take or its import is using this draft: the recorder mustn't drop it as empty. */
  holds: (draftId: string) => boolean;
  /**
   * Record screen, for the recorder's draft (`draft` makes it if needed); `enableMic`: its mic;
   * `anchor`: where the clip goes (the recorder's insert cursor at the tap).
   */
  start: (draft: () => Promise<string>, enableMic: boolean, anchor: ClipAnchor) => Promise<void>;
  stop: () => Promise<void>;
  /** The take's Stop, in the recorder's lower controls. */
  StopPill: ComponentType<{
    began: number | null;
    starting: boolean;
    stopping: boolean;
    onStop: () => void;
  }>;
};
