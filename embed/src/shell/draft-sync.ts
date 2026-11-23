import { topScreen, type FlowEvent, type FlowState } from '../flow/reducer';

/**
 * Keeps the reducer in step with the flow's draft. The screens report where they go (onEdit,
 * onExport, onClose), not what they write: a take landing, a clip trimmed or deleted, a merge.
 * Those are in the library, so the shell reads the draft whenever the library changes and turns
 * what changed into the reducer's own events, by the screen on top: on the recorder a new clip
 * count is a take (`record` then `stop`), on the editor any change is an edit, on Export a new
 * merge is `merged`.
 */
export type DraftSeen = {
  draftId: string;
  clipCount: number;
  lastModified: number;
  mergedSignature: string | null;
};

/**
 * The events that bring `state` up to `seen`, the draft as the library has it now. `last` is the
 * draft as it was last seen (null at first), which tells an edit that changed no clip count apart
 * from nothing at all.
 */
export function syncEvents(
  state: FlowState,
  seen: DraftSeen | null,
  last: DraftSeen | null,
): FlowEvent[] {
  if (state.end || !seen) return [];
  // The flow's draft, or the one the recorder just made for a new recording.
  if (state.draftId !== null && seen.draftId !== state.draftId) return [];
  const before = last?.draftId === seen.draftId ? last : null;
  switch (topScreen(state)) {
    case 'recorder':
      if (seen.draftId === state.draftId && seen.clipCount === state.clipCount) return [];
      // A new recording's draft row lands before its first clip (and stays empty if that take or
      // import is dropped; the recorder removes it as it unmounts): no take until a clip is there.
      if (state.draftId === null && seen.clipCount === 0) return [];
      return [
        { type: 'record' },
        { type: 'stop', draftId: seen.draftId, clipCount: seen.clipCount },
      ];
    case 'editor':
      if (state.draftId === null) return [];
      return seen.clipCount !== state.clipCount ||
        (before !== null && seen.lastModified !== before.lastModified)
        ? [{ type: 'edited', clipCount: seen.clipCount }]
        : [];
    case 'export':
      return seen.mergedSignature !== null &&
        before !== null &&
        seen.mergedSignature !== before.mergedSignature
        ? [{ type: 'merged' }]
        : [];
  }
}
