/**
 * Per-flow state that lives in module scope (a recorder place on offer, a tip on screen, a paused
 * queue flag, …). The embed's JS runtime outlives each presentation, so state one flow left behind
 * would leak into the next (R1-12). Each owner registers how to clear its own state here; core
 * can't import features, so it never names them. Durable services (the upload manager, the
 * library) register nothing: they're not per flow.
 *
 * The Pulse app has one session per launch and never resets. `PulseCore` in `embedded` mode calls
 * `resetSession()` as it mounts, before any screen renders, so every flow starts clean.
 */
type Reset = () => void;

const resets = new Set<Reset>();

/** Register `reset` to run on every `resetSession()`. Returns the unregister function. */
export function onSessionReset(reset: Reset): () => void {
  resets.add(reset);
  return () => {
    resets.delete(reset);
  };
}

/**
 * Clear every registered piece of per-flow state, in registration order. One failing reset is
 * logged and doesn't stop the others.
 */
export function resetSession(): void {
  for (const reset of [...resets]) {
    try {
      reset();
    } catch (e) {
      console.warn('[session] a reset failed', e);
    }
  }
}
