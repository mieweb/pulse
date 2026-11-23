import { type ComponentType, createContext, type ReactNode, useContext } from 'react';

import type { MergedOutput, ReturnTo, UploadClaim } from './types';
import { uploadLog } from './upload-log';

/**
 * Where uploads go, how the person picks one, and how a target is spent on a draft (plan AD2,
 * E1). The shell sets one in `UploadStrategyContext`; screens never pick. The Pulse app's is the
 * pool of destinations paired from links (`upload/pairing/pool-provider.ts`); the embed's will be
 * the host's. A provider is set once for the shell's lifetime.
 */
export interface UploadTargetProvider {
  /** `pool`: destinations paired from links. `host`: targets the host app hands out. */
  readonly kind: 'pool' | 'host';
  /** Spend the target on the draft and start uploading it. */
  claim(claim: UploadClaim): Promise<void>;
  /**
   * One draft's targets, picker included: sets `UploadTargetsContext` for the screen under it.
   * The shell renders it around the export screen, through `UploadTargetsScope`.
   */
  readonly Targets: ComponentType<{ draftId: string; children: ReactNode }>;
}

/** A target the person picked, before it is spent on a draft. */
export type UploadTarget = Pick<UploadClaim, 'destinationId' | 'destination' | 'returnTo'>;

/** The way back to the host page an upload came from, as the export screen offers it. */
export type BackToHost = { url: string; label: string; unusualHost: boolean };

/**
 * The upload targets the shell offers one draft, as the export screen shows them. Picking is the
 * provider's: the screen renders `picker`, names its button after `picked` and claims what
 * `resolvePicked` reads back.
 */
export type UploadTargets = {
  /** Whether there are targets to pick from: the picker and the Upload button show. */
  readonly available: boolean;
  /** The picker over the targets, ready to render. */
  readonly picker: ReactNode;
  /** The picked target's names for the Upload button, or null while none is picked. */
  readonly picked: { name: string; spokenName: string } | null;
  /** A line saying the draft's own target is gone and how to get another, or null. */
  readonly reopen: string | null;
  /** The picked target, read fresh for claiming; null when none is picked, or it's gone or spent. */
  resolvePicked(): Promise<UploadTarget | null>;
  /** The way back to the host page a finished upload came from, or null. */
  backToHost(returnTo: ReturnTo | null | undefined): BackToHost | null;
  /** Opens a finished upload's link. */
  watch(url: string): Promise<void>;
  /** Offers a finished upload's link in the share sheet. */
  share(url: string): Promise<void>;
};

/** No targets: the shell offers no upload here (no provider, or none around the screen). */
export const NO_TARGETS: UploadTargets = {
  available: false,
  picker: null,
  picked: null,
  reopen: null,
  resolvePicked: async () => null,
  backToHost: () => null,
  watch: async () => {},
  share: async () => {},
};

/**
 * The shell's upload targets. None (null) means the shell offers no upload: the embed in `file`
 * mode, which hands the video back to the host instead.
 */
export const UploadStrategyContext = createContext<UploadTargetProvider | null>(null);

/** The upload targets the shell set (see `UploadStrategyContext`), or null for none. */
export function useUploadStrategy(): UploadTargetProvider | null {
  return useContext(UploadStrategyContext);
}

/** One draft's targets, set by the provider's `Targets` (see `UploadTargetsScope`). */
export const UploadTargetsContext = createContext<UploadTargets>(NO_TARGETS);

/** The draft's upload targets from the shell's provider, or `NO_TARGETS`. */
export function useUploadTargets(): UploadTargets {
  return useContext(UploadTargetsContext);
}

/**
 * Offers the screen under it the shell's targets for `draftId`: the provider's `Targets`, or
 * `NO_TARGETS` when the shell set no provider.
 */
export function UploadTargetsScope({
  draftId,
  children,
}: {
  draftId: string;
  children: ReactNode;
}): ReactNode {
  const provider = useUploadStrategy();
  return provider ? <provider.Targets draftId={draftId}>{children}</provider.Targets> : children;
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
