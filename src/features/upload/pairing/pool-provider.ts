import type { UploadTargetProvider } from '@/features/upload/core/target-provider';
import { uploads } from '@/features/upload/core/upload-manager';

import { PoolTargets } from './pool-targets';

/**
 * The Pulse app's upload targets: the pool of destinations paired from links, picked on the export
 * screen with the pool's own picker (`PoolTargets`). Spending one is the upload manager's `claim`,
 * unchanged: it pairs the draft, deletes the pool row and starts the upload.
 */
export const poolProvider: UploadTargetProvider = {
  kind: 'pool',
  claim: (claim) => uploads.claim(claim),
  Targets: PoolTargets,
};
