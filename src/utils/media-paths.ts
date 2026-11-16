// Where a draft's files live, relative to the documents directory. Pure, so the persistence code
// (and its tests) can list every file the library needs without touching the file system.
//   drafts/{draftId}/segments/{segmentId}.mp4               — pristine original
//   drafts/{draftId}/segments/{segmentId}.edited.{rev}.mp4  — re-encoded editor output

export function segmentRelPath(draftId: string, segmentId: string): string {
  return `drafts/${draftId}/segments/${segmentId}.mp4`;
}

/**
 * A baked edit's relative path (older versions re-encoded edits) — coexists with the pristine
 * original. Each
 * edit gets a fresh revision stamp so the path (and thus every path-derived cache key: the
 * segment signature, the expo-video source URI, the expo-image cover URI) changes whenever the
 * content changes. Reusing one fixed path would leave those caches serving the previous edit.
 */
export function editedSegmentRelPath(draftId: string, segmentId: string, rev: number): string {
  return `drafts/${draftId}/segments/${segmentId}.edited.${rev}.mp4`;
}

/** The pristine clip's persisted jpeg thumbnail (relative path). */
export function thumbRelPath(draftId: string, segmentId: string): string {
  return `drafts/${draftId}/segments/${segmentId}.thumb.jpg`;
}

/**
 * The edited clip's persisted jpeg thumbnail (relative path), derived from the edited file's
 * own path (`….mp4` → `….thumb.jpg`). Pairing the thumb to the exact edited revision keeps the
 * rendered URI distinct across edits — otherwise expo-image would serve a stale frame from its
 * cache for an identical URI. Deriving (instead of rebuilding from ids) also resolves the thumb
 * for rows created before revision stamps existed.
 */
export function editedThumbRelPath(editedRelPath: string): string {
  return editedRelPath.replace(/\.mp4$/, '.thumb.jpg');
}

/**
 * An edited clip's cover (relative path), revision-stamped for the same reason as edited files:
 * a fixed path would let expo-image serve the previous edit's frame from its cache.
 */
export function editCoverRelPath(draftId: string, segmentId: string, rev: number): string {
  return `drafts/${draftId}/segments/${segmentId}.cover.${rev}.jpg`;
}

/**
 * The draft's persisted merged export (relative path). One per draft, inside the draft dir so
 * `deleteDraftDir` removes it for free; its content key lives on the `drafts` row
 * (`merged_signature`). Never bundled into a `.pulse` transfer — it's derived, re-mergeable data.
 */
export function exportRelPath(draftId: string): string {
  return `drafts/${draftId}/export.mp4`;
}
