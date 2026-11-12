import type { PulseState } from './document';

/** Retain document sequence when reading SQL rows, whose physical order has no meaning. */
export function preservePulseCollectionOrder(state: PulseState, previous: PulseState): PulseState {
  const identity = (key: keyof PulseState, row: PulseState[keyof PulseState][number]): string => {
    if ('id' in row) return row.id;
    if ('key' in row) return row.key;
    if (key === 'clipTranscripts' && 'segmentId' in row) {
      return JSON.stringify([row.segmentId, row.model]);
    }
    if ('draftId' in row) return row.draftId;
    throw new Error(`Missing Pulse collection identity: ${key}`);
  };
  function ordered<K extends keyof PulseState>(key: K): PulseState[K] {
    const rows = new Map(state[key].map((row) => [identity(key, row), row]));
    const result: PulseState[K][number][] = [];
    for (const old of previous[key]) {
      const id = identity(key, old);
      const current = rows.get(id);
      if (current) {
        result.push(current);
        rows.delete(id);
      }
    }
    result.push(...rows.values());
    return result as PulseState[K];
  }
  return {
    drafts: ordered('drafts'),
    segments: ordered('segments'),
    draftTranscripts: ordered('draftTranscripts'),
    clipTranscripts: ordered('clipTranscripts'),
    settings: ordered('settings'),
    uploadDestinations: ordered('uploadDestinations'),
  };
}
