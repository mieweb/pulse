import { createContext, useContext } from 'react';

import type { MergedOutput, UploadClaim } from './types';
import { uploadLog } from './upload-log';

/**
 * Where uploads go, and how a target is spent on a draft (plan AD2, E1). The shell picks one and
 * hands it down through `UploadStrategyContext`; screens never pick. The Pulse app's is the pool
 * of destinations paired from links (`upload/pairing/pool-provider.ts`); the embed's will be the
 * host's.
 */
export interface UploadTargetProvider {
  /** `pool`: destinations paired from links. `host`: targets the host app hands out. */
  readonly kind: 'pool' | 'host';
  /** Spend the target on the draft and start uploading it. */
  claim(claim: UploadClaim): Promise<void>;
}

/** A target the person picked, before it is spent on a draft. */
export type UploadTarget = Pick<UploadClaim, 'destinationId' | 'destination' | 'returnTo'>;

/**
 * The shell's upload targets. None (null) means the shell offers no upload: the embed in `file`
 * mode, which hands the video back to the host instead.
 */
export const UploadStrategyContext = createContext<UploadTargetProvider | null>(null);

/** The upload targets the shell set (see `UploadStrategyContext`), or null for none. */
export function useUploadStrategy(): UploadTargetProvider | null {
  return useContext(UploadStrategyContext);
}

/**
 * Spend `target` on the draft through `provider` and start uploading its merged video. Nothing
 * happens without a provider, a target or the merged video (the merge hasn't landed yet).
 * Resolves whether the claim was handed to the provider.
 */
export async function startUpload(
  provider: UploadTargetProvider | null,
  params: {
    draftId: string;
    target: UploadTarget | null;
    segments: UploadClaim['segments'];
    merged: MergedOutput | null;
  },
): Promise<boolean> {
  const { draftId, target, segments, merged } = params;
  if (!target || !merged) return false;
  if (!provider) {
    uploadLog.warn('upload: this shell set no upload targets; nothing was sent');
    return false;
  }
  const { destinationId, destination, returnTo } = target;
  await provider.claim({ draftId, destinationId, destination, segments, merged, returnTo });
  return true;
}
