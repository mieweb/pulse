/**
 * What the drafts screen (Home) is given: where its exits go. The standalone route
 * (src/app/index.tsx) maps them to router pushes.
 */
export type DraftsScreenProps = {
  /** + : choose a blank project or gather beats into a summary. */
  onRecord: () => void;
  /** A draft's card was tapped (never while it uploads): open it for editing. */
  onOpenDraft: (draftId: string) => void;
  /** The About button. */
  onAbout: () => void;
  /** When set, the header shows Close: back to the app Pulse is embedded in, without a video. */
  onClose?: () => void;
};
