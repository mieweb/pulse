import type { ClipAnchor } from '@/core/clip-anchor';
import type { EditorView } from '@/db/settings';
import type { PlaceLabels, ScreenCapturePort } from '@/features/recorder/contract';

/**
 * What the editor screen is given: the draft to open and where its exits go. The standalone route
 * (src/app/editor.tsx) maps the callbacks to router pushes; a host shell maps them to its own
 * stack. Keep the callbacks stable (module-level or memoized), as a route's are.
 */
export type EditorScreenProps = {
  draftId: string;
  /** Opens paused at this clip's start, the timeline fitted to it (a clip tapped in the recorder). */
  clipId?: string;
  /**
   * Opens paused at this clip boundary (`timeAtAnchor`: the start of the clip it names, or the end):
   * the recorder's insert cursor, on its Edit. `clipId` wins when both are given.
   */
  anchor?: ClipAnchor;
  /** The view to open in when none was remembered from an earlier session (default Clips). */
  view?: EditorView;
  /** Keep a persisted empty draft open so media can be added; otherwise it closes when empty. */
  allowEmpty?: boolean;
  /** Close, and the draft running out of clips when `allowEmpty` is false. */
  onClose: () => void;
  /** Export, after the editor's pending writes are on disk. */
  onExport: (draftId: string) => void;
  /** Optional developer experiment. Only the standalone developer shell supplies it. */
  onAiEdit?: (draftId: string) => void;
  /**
   * "Record a clip here" in the editor's "+": the recorder for this draft, its insert cursor at
   * `anchor` (the exact playhead, including a pending metadata split). Without it the "+" offers only what the editor does
   * itself (import, screen recording).
   */
  onAddClips?: (draftId: string, anchor: ClipAnchor) => void;
  /**
   * Screen recording, from the Pulse app (src/features/screen-capture), as the recorder gets it:
   * with it the "+" offers Record screen, and the take's Stop shows in the lower controls. The embed
   * has none (`npm run check:embed`).
   */
  screenCapture?: ScreenCapturePort;
  /** Captions with no model, the model control and the "pick a model" status open the model sheet. */
  onOpenModelSheet: () => void;
  /** What paired places are called, for drafts named after one ("From another Pulse"). */
  placeLabels?: PlaceLabels;
};
