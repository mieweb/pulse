// What a shell gives the export screen and what it hears back. The standalone app maps these to
// router calls (src/app/export.tsx); the embed shell maps them to its own flow. The screen itself
// never navigates.

/** The merged video, as the screen hands it on. */
export type ExportedVideo = { draftId: string; path: string; durationMs: number };

/** A Send that reached Pulse's outbox (uploadMode 'pulse'): what the flow's result carries. */
export type SentVideo = {
  draftId: string;
  clientKey: string;
  draftKey: string;
  sentAt: number;
  /** When the host's `confirmSend` succeeded (types with `confirmSend` only). */
  confirmedAt?: number;
};

/** What the screen's main button does. */
export type ExportPrimaryAction =
  /** The Pulse app: upload to a destination picked from the paired pool. */
  | { kind: 'upload-pool' }
  /**
   * Inside a host: hand the video back. `label` is the button's text ("Use this video" when
   * blank).
   */
  | { kind: 'use-video'; label: string; onUse: (video: ExportedVideo) => void }
  /**
   * Inside a host in uploadMode 'pulse' (AD23): Send through Pulse's outbox (send-flow.ts), the
   * button named by the draft's upload type. `onSent` once the job is queued; `onKeepDraft` is the
   * [Keep draft] offered after the host's confirm failed. `onSending(true)` as a Send starts (the
   * merge, the host's confirm) and `onSending(false)` when it stops without going: the shell holds
   * the host's close meanwhile, as the screen holds X and back.
   */
  | {
      kind: 'send';
      onSent: (sent: SentVideo) => void;
      onKeepDraft: () => void;
      onSending?: (busy: boolean) => void;
    };

/** What the host lets the screen offer besides the primary action. */
export type ExportPolicy = { allowShare: boolean; allowSaveToPhotos: boolean };

/** How the screen was left. */
export type ExportCloseResult = {
  /**
   * True while an upload holds the draft: the screen under Export (an editable recorder or
   * editor) should be skipped on the way out.
   */
  draftLocked: boolean;
};

export type ExportScreenProps = {
  draftId: string;
  primaryAction: ExportPrimaryAction;
  policy: ExportPolicy;
  /**
   * Whether the app declares the purpose string Save to Photos needs (iOS
   * NSPhotoLibraryAddUsageDescription). Without it the request would crash, so the button is
   * hidden whatever `policy` says. Default true: the Pulse app declares it.
   */
  photosAddPurpose?: boolean;
  onClose: (result: ExportCloseResult) => void;
  /**
   * "Too large to send · Trim": take the person to the editor for this draft. Without it the
   * Trim action is hidden (the warning stays).
   */
  onTrim?: () => void;
  /**
   * Go back to the page a place's link came from, once its upload is in. Without it the screen
   * offers no way back.
   */
  onBackToHost?: (url: string) => void;
  /**
   * The video matches the draft's clips now: a merge finished, or the export saved on an earlier
   * visit still matched and was used as is. Called each time the merge reaches done.
   */
  onReady?: (video: ExportedVideo) => void;
};
