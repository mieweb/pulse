import { createPresence } from '@/utils/presence';

/**
 * The recorder screens mounted right now, and how to make each save its in-flight take — for
 * navigation that replaces the recorder from outside it (a link opening its place's recorder,
 * see `upload-deep-link-provider`), the way the recorder's close button finalizes before leaving.
 */
const presence = createPresence();
const finalizers = new Set<() => Promise<void>>();

/** Called by a mounted recorder; the returned function unregisters it on unmount. */
export function registerRecorder(finalize: () => Promise<void>): () => void {
  finalizers.add(finalize);
  const leave = presence.enter();
  return () => {
    finalizers.delete(finalize);
    leave();
  };
}

/** Stop and save any take in progress, in every mounted recorder. */
export async function finalizeRecorders(): Promise<void> {
  await Promise.all([...finalizers].map((finalize) => finalize().catch(() => {})));
}

/** Resolves once no recorder is mounted (its camera released), or after `timeoutMs`. */
export function recordersGone(timeoutMs: number): Promise<void> {
  return presence.whenGone(timeoutMs);
}
