import { AppState } from 'react-native';

import { uploads } from './upload-manager';

/** What a shell hands the upload manager when it starts it. */
export type UploadShell = {
  /** The foreground failure surface (the shell's toast). */
  showToast: (message: string, kind?: 'success' | 'error') => void;
  /** How a finished upload's link reaches the clipboard; null where there is none (the embed). */
  copyLink: ((text: string) => Promise<boolean>) | null;
};

/**
 * Start the upload manager for the shell's lifetime: its toast and clipboard first, then the
 * launch check (`prepareLaunch`: fail the uploads a killed app never finished), and on every
 * foreground a poke of the drain, so an upload whose JS was suspended in the background carries
 * on. Returns the stop for the foreground listener. The shell calls it once it can show a toast,
 * before any upload can resume.
 */
export function startUploads({ showToast, copyLink }: UploadShell): () => void {
  uploads.registerToast(showToast);
  uploads.setCopyLink(copyLink);
  void uploads.prepareLaunch();
  const sub = AppState.addEventListener('change', (next) => {
    if (next === 'active') void uploads.ensureRunning();
  });
  return () => sub.remove();
}
