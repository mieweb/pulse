/**
 * The draft the open flow holds (native-bridge.md §3 busy matrix): host writes on it refuse with
 * `draft.locked` while the flow is up; writes on any other draft go ahead. The flow registers a
 * getter as it mounts (a new recording has no draft until its first clip lands, so the id is read
 * when a write comes, not when the flow starts) and lets go as it unmounts.
 */
let current: (() => string | null) | null = null;

/** The flow's draft from now on; the returned function lets go (only if still this one). */
export function holdFlowDraft(draftId: () => string | null): () => void {
  current = draftId;
  return () => {
    if (current === draftId) current = null;
  };
}

/** The id of the draft the open flow holds, or null. */
export function heldDraft(): string | null {
  return current?.() ?? null;
}
