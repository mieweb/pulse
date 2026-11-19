import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CatalogFile, DraftState } from './catalog';
import {
  CATALOG_FILE,
  CATALOG_PART,
  countDrafts,
  listDrafts,
  readCatalogFile,
  shownState,
  type CountOptions,
  type DraftFilter,
  type NetworkView,
} from './catalog-filter';

// The shared vectors: PulseKit's Swift catalog reader (PR2-D) runs the same file, so listDrafts and
// countDrafts answer the same from native as they would from here.
type Vectors = {
  format: string;
  version: number;
  catalog: CatalogFile;
  listDrafts: { name: string; net: NetworkView; filter: DraftFilter; expect: [string, string][] }[];
  countDrafts: {
    name: string;
    net: NetworkView;
    options: CountOptions;
    expect: Record<string, number>;
  }[];
  shownState: { name: string; state: DraftState; net: NetworkView; expect: DraftState }[];
  readCatalog: {
    name: string;
    reads: Record<string, (string | null)[]>;
    expect: number | null;
  }[];
};

const vectors = JSON.parse(
  readFileSync(join(__dirname, '__vectors__/catalog.json'), 'utf8'),
) as Vectors;
const ON: NetworkView = { online: true, wifi: true, wifiOnlyUploads: false };

describe('catalog vectors', () => {
  it('is the vectors file this reader knows', () => {
    expect(vectors.format).toBe('pulse-catalog-vectors');
    expect(vectors.version).toBe(1);
    expect(vectors.catalog.drafts.every((d) => d.state !== 'waiting_network')).toBe(true);
  });

  describe('listDrafts', () => {
    for (const v of vectors.listDrafts) {
      it(v.name, () => {
        const rows = listDrafts(vectors.catalog, v.filter, v.net);
        expect(rows.map((r) => [r.id, r.state])).toEqual(v.expect);
      });
    }
  });

  describe('countDrafts', () => {
    for (const v of vectors.countDrafts) {
      it(v.name, () => {
        expect(countDrafts(vectors.catalog, v.options, v.net)).toEqual(v.expect);
      });
    }
  });

  describe('shownState', () => {
    for (const v of vectors.shownState) {
      it(v.name, () => {
        expect(shownState(v.state, v.net)).toBe(v.expect);
      });
    }
  });

  describe('readCatalog', () => {
    for (const v of vectors.readCatalog) {
      it(v.name, () => {
        // Each file answers its successive reads from its list, the last answer repeating.
        const seen: Record<string, number> = {};
        const read = (name: string) => {
          const answers = v.reads[name] ?? [null];
          const i = Math.min(seen[name] ?? 0, answers.length - 1);
          seen[name] = (seen[name] ?? 0) + 1;
          return answers[i];
        };
        expect(readCatalogFile(read)?.writtenAt ?? null).toBe(v.expect);
      });
    }
  });
});

describe('catalog filter', () => {
  it('"clock:" groups every clock session, and counts each session on its own', () => {
    const rows = listDrafts(vectors.catalog, { contextKeyPrefix: 'clock:' }, ON);
    expect(new Set(rows.map((r) => r.context?.key))).toEqual(new Set(['clock:e1', 'clock:e2']));
    expect(countDrafts(vectors.catalog, { by: 'contextKey', states: undefined }, ON)).toEqual(
      expect.objectContaining({ 'clock:e1': 2, 'clock:e2': 1 }),
    );
  });

  it('attentionOnly counts a failed upload and an undismissed kept receipt, nothing else', () => {
    const counts = countDrafts(vectors.catalog, { by: 'contextKind', attentionOnly: true }, ON);
    expect(counts).toEqual({ ticket: 1, clock: 1 });
    // Dismissing the kept receipt stops it counting.
    const dismissed: CatalogFile = {
      ...vectors.catalog,
      receipts: vectors.catalog.receipts.map((r) =>
        r.sent ? { ...r, sent: { ...r.sent, dismissed: true } } : r,
      ),
    };
    expect(countDrafts(dismissed, { by: 'contextKind', attentionOnly: true }, ON)).toEqual({
      ticket: 1,
    });
  });

  it('leaves the catalog as it was (the shown state is the answer’s, not the file’s)', () => {
    const before = JSON.stringify(vectors.catalog);
    listDrafts(vectors.catalog, {}, { online: false, wifi: false, wifiOnlyUploads: false });
    expect(JSON.stringify(vectors.catalog)).toBe(before);
  });

  it('reads the .part only while catalog.json is missing, and catalog.json again after it', () => {
    const order: string[] = [];
    const read = (name: string) => (order.push(name), null);
    expect(readCatalogFile(read)).toBeNull();
    expect(order).toEqual([CATALOG_FILE, CATALOG_PART, CATALOG_FILE]);
  });
});
