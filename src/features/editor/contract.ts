import type { EditorView } from '@/db/settings';

/**
 * What the editor screen is given: the draft to open and where its exits go. The standalone route
 * (src/app/editor.tsx) maps the callbacks to router pushes; a host shell maps them to its own
 * stack. Keep the callbacks stable (module-level or memoized), as a route's are.
 */
export type EditorScreenProps = {
  draftId: string;
  /** Opens paused at this clip's start, the timeline fitted to it (a clip tapped in the recorder). */
  clipId?: string;
  /** The view to open in when none was remembered from an earlier session (default Clips). */
  view?: EditorView;
  /** Close, and the draft running out of clips. */
  onClose: () => void;
  /** Export, after the editor's pending writes are on disk. */
  onExport: (draftId: string) => void;
  /** Add clips to this draft in the recorder. Nothing calls it yet: the Add clips control is to come. */
  onAddClips?: (draftId: string) => void;
  /** Captions with no model, the model control and the "pick a model" status open the model sheet. */
  onOpenModelSheet: () => void;
};
