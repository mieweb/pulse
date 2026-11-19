import type { CatalogDraft, CatalogFile, DraftState } from './catalog';

// How the catalog's reader answers listDrafts and countDrafts (native-bridge.md §6.1). PulseKit
// answers them in Swift from catalog.json without starting Pulse (PR2-D); this is the same rule in
// TypeScript, and both run the shared vectors in __vectors__/catalog.json, so the two can't drift.

/** The catalog's name under the namespace's documents root, and where each write goes first. */
export const CATALOG_FILE = 'catalog.json';
export const CATALOG_PART = `${CATALOG_FILE}.part`;

/** `text` as a catalog, or null when it isn't one (missing, cut short, or another file). */
export function parseCatalog(text: string | null): CatalogFile | null {
  if (text == null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const c = value as Partial<CatalogFile>;
  if (c.format !== 'pulse-catalog' || typeof c.version !== 'number') return null;
  if (!Array.isArray(c.drafts) || !Array.isArray(c.receipts)) return null;
  return value as CatalogFile;
}

/**
 * How a reader finds the catalog. `read(name)` returns the file's text, or null when there's no
 * such file; the reader calls it in this order:
 *
 * 1. `catalog.json`. The writer only ever moves a finished file there, so it's always whole.
 * 2. When it's missing, `catalog.json.part`. expo-file-system can't rename over a file: the writer's
 *    move deletes `catalog.json` and then moves the `.part` in, so in that gap (or after a kill
 *    inside it) the `.part` is the newest whole catalog. A `.part` beside a `catalog.json` is a write
 *    in progress, and is never read.
 * 3. When the `.part` is missing or cut short, `catalog.json` once more: the move may have landed
 *    between the first two reads, and the next write started its own `.part`.
 *
 * Nothing that parses means no catalog: the reader answers as if it were empty. Before the first
 * write ever finishes that is the truth; a cut-short `.part` with no `catalog.json` is only ever a
 * first write killed midway.
 */
export function readCatalogFile(read: (name: string) => string | null): CatalogFile | null {
  return (
    parseCatalog(read(CATALOG_FILE)) ??
    parseCatalog(read(CATALOG_PART)) ??
    parseCatalog(read(CATALOG_FILE))
  );
}

/** What the reader knows about the network, and the host's Wi-Fi-only choice. */
export type NetworkView = { online: boolean; wifi: boolean; wifiOnlyUploads: boolean };

/** `DraftFilter`. */
export type DraftFilter = {
  contextKey?: string;
  contextKeyPrefix?: string;
  contextKind?: string;
  /** Default: every state but 'sent'. */
  states?: DraftState[];
};

/** `CountOptions`. */
export type CountOptions = {
  by: 'contextKey' | 'contextKind';
  /** Only rows that need the person: 'failed', and 'sent' kept by the server and not dismissed. */
  attentionOnly?: boolean;
  states?: DraftState[];
};

/**
 * The catalog's order, and the order listDrafts answers in: the newest change first, equal times by
 * id (ascending, by UTF-16 code unit), so every reader sorts the same way.
 */
export function catalogOrder(a: CatalogDraft, b: CatalogDraft): number {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const UNSENT: readonly DraftState[] = [
  'draft',
  'ready',
  'preparing',
  'queued',
  'waiting_network',
  'uploading',
  'delivering',
  'needs_credentials',
  'failed',
];

/**
 * The state the host sees: a queued upload waits for the network while there is none, or while
 * uploads wait for Wi-Fi and there's no Wi-Fi. The catalog never stores `waiting_network`.
 */
export function shownState(state: DraftState, net: NetworkView): DraftState {
  if (state !== 'queued') return state;
  return !net.online || (net.wifiOnlyUploads && !net.wifi) ? 'waiting_network' : 'queued';
}

/** The catalog's rows in the states asked for, with their shown state, in catalog order. */
function rowsIn(
  catalog: CatalogFile,
  states: readonly DraftState[],
  net: NetworkView,
): CatalogDraft[] {
  const wanted = new Set(states);
  const rows = wanted.has('sent') ? [...catalog.drafts, ...catalog.receipts] : catalog.drafts;
  return rows
    .map((row) => ({ ...row, state: shownState(row.state, net) }))
    .filter((row) => wanted.has(row.state))
    .sort(catalogOrder);
}

/** `listDrafts(filter)`: rows in the asked states for the asked place, newest change first. */
export function listDrafts(
  catalog: CatalogFile,
  filter: DraftFilter,
  net: NetworkView,
): CatalogDraft[] {
  return rowsIn(catalog, filter.states ?? UNSENT, net).filter((row) => {
    if (filter.contextKey !== undefined && row.context?.key !== filter.contextKey) return false;
    if (
      filter.contextKeyPrefix !== undefined &&
      !(row.context?.key.startsWith(filter.contextKeyPrefix) ?? false)
    ) {
      return false;
    }
    if (filter.contextKind !== undefined && row.context?.kind !== filter.contextKind) return false;
    return true;
  });
}

/** Whether a row needs the person: its upload failed, or the server kept it and they haven't seen it. */
export function needsAttention(row: CatalogDraft): boolean {
  if (row.state === 'failed') return true;
  return row.state === 'sent' && row.sent?.outcome === 'kept' && !row.sent.dismissed;
}

/**
 * `countDrafts(options)`: how many rows each place (`by: 'contextKey'`) or kind of place
 * (`'contextKind'`) has, in the asked states (default every state but 'sent'), or with
 * `attentionOnly` only those that need the person (failed, and kept receipts not dismissed; asked
 * states narrow these further). Rows without a place aren't counted; places with none are left out.
 */
export function countDrafts(
  catalog: CatalogFile,
  options: CountOptions,
  net: NetworkView,
): Record<string, number> {
  const states = options.states ?? (options.attentionOnly ? [...UNSENT, 'sent'] : UNSENT);
  const counts: Record<string, number> = {};
  for (const row of rowsIn(catalog, states, net)) {
    if (!row.context) continue;
    if (options.attentionOnly && !needsAttention(row)) continue;
    const group = options.by === 'contextKind' ? row.context.kind : row.context.key;
    counts[group] = (counts[group] ?? 0) + 1;
  }
  return counts;
}
