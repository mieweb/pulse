import type { UploadTargetProvider } from '@/features/upload/core/target-provider';
import { uploads } from '@/features/upload/core/upload-manager';

/**
 * The Pulse app's upload targets: the pool of destinations paired from links. Spending one is the
 * upload manager's `claim`, unchanged: it pairs the draft, deletes the pool row and starts the
 * upload.
 */
export const poolProvider: UploadTargetProvider = {
  kind: 'pool',
  claim: (claim) => uploads.claim(claim),
};
