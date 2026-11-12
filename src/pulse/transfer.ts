import {
  isSafePulsePath,
  validatePulseDocument,
  validatePulseState,
  type PulseDocument,
  type PulseState,
} from './document';

/** A selection still carries global metadata for an explicit future exact restore. */
export function selectPulseDrafts(
  source: PulseDocument,
  draftIds: readonly string[],
): PulseDocument {
  validatePulseDocument(source);
  if (draftIds.length === 0) throw new Error('No drafts selected.');
  const ids = new Set(draftIds);
  for (const id of ids) {
    if (!source.state.drafts.some((draft) => draft.id === id))
      throw new Error(`Draft is missing: ${id}`);
  }
  const state: PulseState = JSON.parse(JSON.stringify(source.state));
  state.drafts = state.drafts.filter((draft) => ids.has(draft.id));
  state.segments = state.segments.filter((segment) => ids.has(segment.draftId));
  const segmentIds = new Set(state.segments.map((segment) => segment.id));
  state.draftTranscripts = state.draftTranscripts.filter((row) => ids.has(row.draftId));
  state.clipTranscripts = state.clipTranscripts.filter((row) => segmentIds.has(row.segmentId));
  const paths = new Set(
    state.segments.flatMap((segment) =>
      [segment.originalFilename, segment.editedFilename, segment.thumbnail].filter(
        (p): p is string => p !== null,
      ),
    ),
  );
  for (const id of ids) paths.add(`drafts/${id}/export.mp4`);
  const document: PulseDocument = {
    ...source,
    scope: 'selection',
    state,
    assets: source.assets.filter((asset) => paths.has(asset.path)).map((asset) => ({ ...asset })),
  };
  validatePulseDocument(document);
  return document;
}

export type PulseCopy = {
  state: PulseState;
  draftIds: string[];
  /** Imported logical path -> source logical path, including shared originals only once. */
  mediaPaths: Map<string, string>;
};

/**
 * A deliberate copy, separate from exact restore. Local settings/destination trust stays local;
 * upload/context pairing and merged-export cache are cleared. Editable state remains intact.
 * The caller stages every mediaPaths entry before committing this state atomically.
 */
export function copyPulseDrafts(
  current: PulseState,
  incoming: PulseDocument,
  namespace: string,
  freshId: () => string,
): PulseCopy {
  validatePulseState(current);
  validatePulseDocument(incoming);
  if (!isSafePulsePath(namespace)) throw new Error('Unsafe Pulse import namespace.');
  const state: PulseState = JSON.parse(JSON.stringify(current));
  const draftIds = new Map(incoming.state.drafts.map((row) => [row.id, freshId()]));
  const segmentIds = new Map(incoming.state.segments.map((row) => [row.id, freshId()]));
  const remap = (path: string) => (isSafePulsePath(path) ? `${namespace}/${path}` : path);
  const mediaPaths = new Map(incoming.assets.map((asset) => [remap(asset.path), asset.path]));
  const replaced = [...incoming.assets.map((asset) => asset.path)].sort(
    (a, b) => b.length - a.length,
  );
  // Signatures contain paths and edit settings. Replace all known paths in one pass so an
  // inserted namespace cannot accidentally be remapped a second time.
  const expression =
    replaced.length > 0
      ? new RegExp(
          replaced.map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
          'g',
        )
      : null;
  const remapSignature = (signature: string) =>
    expression ? signature.replace(expression, remap) : signature;
  const remapCaption = (raw: string | null): string | null => {
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed as { file?: unknown }).file === 'string'
      ) {
        const caption = parsed as Record<string, unknown> & { file: string };
        return JSON.stringify({ ...caption, file: remap(caption.file) });
      }
    } catch {
      /* Invalid historical text is durable data too. */
    }
    return raw;
  };
  state.drafts.push(
    ...incoming.state.drafts.map((row) => ({
      ...row,
      id: draftIds.get(row.id)!,
      uploadServer: null,
      uploadArtifactId: null,
      uploadStatus: null,
      contextServer: null,
      contextRef: null,
      mergedSignature: null,
      mergedDurationMs: null,
    })),
  );
  state.segments.push(
    ...incoming.state.segments.map((row) => ({
      ...row,
      id: segmentIds.get(row.id)!,
      draftId: draftIds.get(row.draftId)!,
      originalFilename: remap(row.originalFilename),
      editedFilename: row.editedFilename === null ? null : remap(row.editedFilename),
      thumbnail: row.thumbnail === null ? null : remap(row.thumbnail),
      captionEdit: remapCaption(row.captionEdit),
    })),
  );
  state.draftTranscripts.push(
    ...incoming.state.draftTranscripts.map((row) => ({
      ...row,
      draftId: draftIds.get(row.draftId)!,
      signature: remapSignature(row.signature),
    })),
  );
  state.clipTranscripts.push(
    ...incoming.state.clipTranscripts.map((row) => ({
      ...row,
      segmentId: segmentIds.get(row.segmentId)!,
      file: remap(row.file),
    })),
  );
  validatePulseState(state); // Includes collisions from an unsuitable UUID factory.
  return { state, draftIds: [...draftIds.values()], mediaPaths };
}
