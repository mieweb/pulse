import { describe, expect, it } from '@jest/globals';

import type { TakenOutClips } from '@/db/drafts';
import type { Segment } from '@/db/schema';

import type { Step } from '@/core/types/editor-history';
import {
  HISTORY_MAX_JSON_BYTES,
  HISTORY_MAX_MEDIA_BYTES,
  HISTORY_MAX_STEPS,
  historyClipIds,
  historyMediaPaths,
  parsePersistedHistory,
  remapPersistedHistory,
  requiredHistoryMediaPaths,
  trimPersistedHistory,
  type PersistedHistory,
} from './persisted-history';

const path = (id: string) => `drafts/d/segments/${id}.mp4`;
const row = (id: string): Segment => ({
  id,
  draftId: 'd',
  addedAt: 1234,
  order: 0,
  label: id,
  originalFilename: path(id),
  durationMs: 1000,
  editedFilename: null,
  editedDurationMs: null,
  editState: null,
  thumbnail: null,
  captionEdit: JSON.stringify({ file: path(id), words: [{ text: id, t0: 0, t1: 20 }] }),
});
const taken = (id: string): TakenOutClips => ({
  draftId: 'd',
  order: [id, 'deleted'],
  rows: [row(id)],
  transcripts: [
    {
      segmentId: id,
      model: 'tiny',
      file: path(id),
      status: 'done',
      words: '[]',
      createdAt: 1,
    },
  ],
});
const state = (id = 'snapshot-only'): Step => ({
  kind: 'state',
  snapshot: { order: [id], edits: { [id]: null }, captions: { [id]: null }, captionY: null },
});
const added = (id: string): Step => ({ kind: 'added', ids: [id], taken: taken(id) });
const history = (past: Step[] = [state()], future: Step[] = [added('x')]): PersistedHistory => ({
  version: 1,
  checkpoint: 'stored-current-state',
  past,
  future,
});
const parse = (value: unknown) => parsePersistedHistory(JSON.stringify(value), 'd');

function compoundHistory(): PersistedHistory {
  const original = row('a');
  original.originalFilename = 'drafts/shared/segments/shared.mp4';
  original.editedFilename = 'drafts/shared/segments/shared.edited.1.mp4';
  original.thumbnail = 'drafts/d/segments/a.cover.2.jpg';
  const compound = added('x');
  if (compound.kind !== 'added' || !compound.taken) throw new Error('fixture');
  compound.taken.replaced = [original];
  compound.splits = [
    { before: { ...taken('a'), rows: [original] }, rightId: 'right', firstInsertedId: 'x' },
  ];
  compound.batchKey = 'an-open-runtime-batch';
  return history([state()], [compound]);
}

describe('saved Undo data validation', () => {
  it('accepts older v1 dormant and split rows without dates, using the unknown-date fallback', () => {
    const legacy = compoundHistory();
    const step = legacy.future[0];
    if (step.kind !== 'added' || !step.taken || !step.splits) throw new Error('fixture');
    const rows = [
      ...step.taken.rows,
      ...(step.taken.replaced ?? []),
      ...step.splits.flatMap((split) => [...split.before.rows, ...(split.before.replaced ?? [])]),
    ];
    for (const clip of rows) delete (clip as Partial<Segment>).addedAt;
    const parsed = parse(legacy)!;
    const next = parsed.future[0];
    if (next.kind !== 'added' || !next.taken || !next.splits) throw new Error('fixture');
    expect(next.taken.rows[0].addedAt).toBe(0);
    expect(next.taken.replaced?.[0].addedAt).toBe(0);
    expect(next.splits[0].before.rows[0].addedAt).toBe(0);
    expect(parse(parsed)).toEqual(parsed);
  });

  it.each([-1, 1.5, null, '1234', Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid saved beat date %s',
    (addedAt) => {
      const invalid = compoundHistory();
      const step = invalid.future[0];
      if (step.kind !== 'added' || !step.taken) throw new Error('fixture');
      Object.assign(step.taken.rows[0], { addedAt });
      expect(() => parse(invalid)).toThrow();
    },
  );

  it('starts old drafts without history empty and round-trips both supported step types', () => {
    expect(parsePersistedHistory(null, 'd')).toBeNull();
    expect(parsePersistedHistory(undefined, 'd')).toBeNull();
    expect(parse(compoundHistory())).toEqual(compoundHistory());
  });

  it.each([
    { ...history(), version: 2 },
    { ...history(), checkpoint: null },
    { ...history(), extra: true },
    { ...history(), past: {} },
    { ...history(), past: Array.from({ length: HISTORY_MAX_STEPS + 1 }, () => state()) },
    {
      ...history(),
      past: [
        {
          kind: 'state',
          snapshot: { order: ['a'], edits: { other: null }, captions: {}, captionY: null },
        },
      ],
    },
    { ...history(), future: [{ kind: 'added', ids: ['a'], taken: null }] },
    { ...history(), past: [{ kind: 'added', ids: ['../outside'], taken: null }] },
    { ...history(), past: [{ kind: 'added', ids: ['__proto__'], taken: null }] },
  ])('rejects malformed, newer and unbounded data %#', (value) => {
    expect(() => parse(value)).toThrow();
  });

  it('rejects unreadable and oversized JSON before hydration', () => {
    expect(() => parsePersistedHistory('{', 'd')).toThrow();
    expect(() => parse({ ...history(), checkpoint: 'a'.repeat(HISTORY_MAX_JSON_BYTES) })).toThrow();
  });

  it('rejects dormant rows that the recorded addition cannot undo', () => {
    expect(() => parse(history([], [{ kind: 'added', ids: ['a'], taken: taken('b') }]))).toThrow();
    const unrelatedReplacement = taken('a');
    unrelatedReplacement.replaced = [row('b')];
    expect(() =>
      parse(history([], [{ kind: 'added', ids: ['a'], taken: unrelatedReplacement }])),
    ).toThrow();
  });

  it('allows additions deleted before Undo while retaining only the clips still available', () => {
    const partial = history(
      [],
      [{ kind: 'added', ids: ['deleted-addition', 'b'], taken: taken('b') }],
    );
    expect(parse(partial)).toEqual(partial);
  });

  it('validates compound and standalone split rows against their replay IDs', () => {
    const compound = compoundHistory();
    const step = compound.future[0];
    if (step.kind !== 'added' || !step.taken || !step.splits) throw new Error('fixture');
    step.taken.rows = [row('a'), row('x'), row('right')];
    step.taken.order = ['a', 'x', 'right'];
    expect(parse(compound)).toEqual(compound);
    step.taken.rows.push(row('unrelated'));
    step.taken.order.push('unrelated');
    expect(() => parse(compound)).toThrow();
    step.taken.rows.pop();
    step.taken.order.pop();
    step.splits[0].firstInsertedId = 'unrecorded-addition';
    expect(() => parse(compound)).toThrow();

    const standalone = history(
      [],
      [
        {
          kind: 'added',
          ids: [],
          taken: {
            ...taken('right'),
            order: ['a', 'right'],
            rows: [row('a'), row('right')],
            replaced: [row('a')],
          },
          splits: [{ before: taken('a'), rightId: 'right' }],
        },
      ],
    );
    expect(parse(standalone)).toEqual(standalone);
  });

  it('rejects cross-draft dormant rows and unsafe references at every nesting level', () => {
    const crossDraft = taken('x');
    crossDraft.rows[0].draftId = 'source';
    expect(() => parse(history([], [{ kind: 'added', ids: ['x'], taken: crossDraft }]))).toThrow();
    const unsafeCaption = state('a');
    if (unsafeCaption.kind !== 'state') throw new Error('fixture');
    unsafeCaption.snapshot.captions.a = JSON.stringify({ file: 'drafts/d/../../secret' });
    expect(() => parse(history([unsafeCaption], []))).toThrow();
    const unsafeOriginal = taken('x');
    unsafeOriginal.rows[0].originalFilename = '/tmp/secret';
    expect(() =>
      parse(history([], [{ kind: 'added', ids: ['x'], taken: unsafeOriginal }])),
    ).toThrow();
    const duplicateTranscript = taken('x');
    duplicateTranscript.transcripts.push({ ...duplicateTranscript.transcripts[0] });
    expect(() =>
      parse(history([], [{ kind: 'added', ids: ['x'], taken: duplicateTranscript }])),
    ).toThrow();
    const foreignTranscript = taken('x');
    foreignTranscript.transcripts[0].segmentId = 'someone-else';
    expect(() =>
      parse(history([], [{ kind: 'added', ids: ['x'], taken: foreignTranscript }])),
    ).toThrow();
  });

  it('rejects duplicate dormant rows, invalid numeric metadata and unsafe split originals', () => {
    const duplicate = taken('x');
    duplicate.rows.push(row('x'));
    expect(() => parse(history([], [{ kind: 'added', ids: ['x'], taken: duplicate }]))).toThrow();
    const invalidDuration = taken('x');
    invalidDuration.rows[0].durationMs = -1;
    expect(() =>
      parse(history([], [{ kind: 'added', ids: ['x'], taken: invalidDuration }])),
    ).toThrow();
    const split = compoundHistory();
    const step = split.future[0];
    if (step.kind !== 'added' || !step.splits) throw new Error('fixture');
    step.splits[0].before.draftId = 'foreign';
    expect(() => parse(split)).toThrow();
    const invalidSplitIds = compoundHistory();
    const addedStep = invalidSplitIds.future[0];
    if (addedStep.kind !== 'added' || !addedStep.splits) throw new Error('fixture');
    addedStep.splits[0].rightId = 'a';
    expect(() => parse(invalidSplitIds)).toThrow();
  });
});

describe('saved Undo references and copy', () => {
  it('preserves original dates through serialization and remapping of dormant and split rows', () => {
    const source = compoundHistory();
    const step = source.future[0];
    if (step.kind !== 'added' || !step.taken || !step.splits) throw new Error('fixture');
    step.taken.rows[0].addedAt = 1234;
    step.splits[0].before.rows[0].addedAt = 5678;
    const copied = remapPersistedHistory(parse(source)!, {
      draftId: 'copy',
      mapId: (id) => `copy-${id}`,
      mapPath: (file) => file.replace(/^drafts\/[^/]+\//, 'drafts/copy/'),
    });
    const copiedStep = copied.future[0];
    if (copiedStep.kind !== 'added' || !copiedStep.taken || !copiedStep.splits)
      throw new Error('fixture');
    expect(copiedStep.taken.rows[0].addedAt).toBe(1234);
    expect(copiedStep.taken.replaced?.[0].addedAt).toBe(5678);
    expect(copiedStep.splits[0].before.rows[0].addedAt).toBe(5678);
    expect(parsePersistedHistory(JSON.stringify(copied), 'copy')).toEqual(copied);
  });

  it('parses and remaps a standalone split with no inserted clips or firstInsertedId', () => {
    const source = history(
      [{ kind: 'added', ids: [], taken: null, splits: [{ before: taken('a'), rightId: 'right' }] }],
      [],
    );
    expect(parse(source)).toEqual(source);
    expect(historyClipIds(source)).toEqual(new Set(['a', 'deleted', 'right']));
    const copy = remapPersistedHistory(source, {
      draftId: 'copy',
      mapId: (id) => `copy-${id}`,
      mapPath: (file) => file.replace('drafts/d/', 'drafts/copy/'),
    });
    expect(parsePersistedHistory(JSON.stringify(copy), 'copy')).toEqual(copy);
    const split = copy.past[0];
    if (split.kind !== 'added') throw new Error('Expected standalone split');
    expect(split.ids).toEqual([]);
    expect(split.splits?.[0]).toMatchObject({ rightId: 'copy-right', before: { draftId: 'copy' } });
    expect(split.splits?.[0]).not.toHaveProperty('firstInsertedId');
    expect(historyClipIds(copy)).toEqual(new Set(['copy-a', 'copy-deleted', 'copy-right']));
    expect(split.splits?.[0]).not.toHaveProperty('fullyRemoved');
    expect(split.splits?.[0]).not.toHaveProperty('appliedIds');
  });

  it.each([true, false])(
    'preserves explicit full-removal outcome %s and bulk identities when remapping',
    (fullyRemoved) => {
      const appliedIds = fullyRemoved ? [] : ['right', 'third'];
      const source = history(
        [
          {
            kind: 'added',
            ids: appliedIds,
            taken: null,
            splits: [{ before: taken('a'), rightId: 'right', fullyRemoved, appliedIds }],
          },
        ],
        [],
      );
      expect(parse(source)).toEqual(source);
      const copy = remapPersistedHistory(source, {
        draftId: 'copy',
        mapId: (id) => `copy-${id}`,
        mapPath: (file) => file.replace('drafts/d/', 'drafts/copy/'),
      });
      expect(parsePersistedHistory(JSON.stringify(copy), 'copy')).toEqual(copy);
      const step = copy.past[0];
      if (step.kind !== 'added') throw new Error('Expected structural step.');
      expect(step.splits?.[0]).toMatchObject({
        fullyRemoved,
        appliedIds: appliedIds.map((id) => `copy-${id}`),
      });
    },
  );

  it.each([
    { fullyRemoved: 'true' },
    { fullyRemoved: null },
    { fullyRemoved: true, firstInsertedId: 'x' },
    { fullyRemoved: true, appliedIds: ['right'] },
    { fullyRemoved: false, appliedIds: [] },
    { fullyRemoved: false, appliedIds: ['right', 'right'] },
    { fullyRemoved: false, appliedIds: ['right', 'unrecorded'] },
    { appliedIds: ['right'] },
  ])('rejects inconsistent whole-removal or applied identities %j', (fields) => {
    const source = history(
      [
        {
          kind: 'added',
          ids: ['right'],
          taken: null,
          splits: [{ before: taken('a'), rightId: 'right', ...fields } as never],
        },
      ],
      [],
    );
    expect(() => parse(source)).toThrow();
  });

  it('lists snapshot-only, dormant, replaced and split IDs and files once', () => {
    const value = compoundHistory();
    expect(historyClipIds(value)).toEqual(new Set(['snapshot-only', 'x', 'deleted', 'a', 'right']));
    expect(historyMediaPaths(value)).toEqual(
      new Set([
        path('x'),
        'drafts/d/segments/x.thumb.jpg',
        'drafts/shared/segments/shared.mp4',
        'drafts/shared/segments/shared.edited.1.mp4',
        'drafts/shared/segments/shared.edited.1.thumb.jpg',
        path('a'),
        'drafts/d/segments/a.thumb.jpg',
        'drafts/d/segments/a.cover.2.jpg',
      ]),
    );
    expect([...requiredHistoryMediaPaths(value)].some((file) => file.endsWith('.jpg'))).toBe(false);
  });

  it('includes files used only by a state caption', () => {
    const snapshot = state('a');
    if (snapshot.kind !== 'state') throw new Error('fixture');
    snapshot.snapshot.captions.a = JSON.stringify({ file: path('caption-only'), words: [] });
    expect(requiredHistoryMediaPaths(history([snapshot], []))).toEqual(
      new Set([path('caption-only')]),
    );
  });

  it('preserves unreadable legacy caption text while remapping valid caption files', () => {
    const snapshot = state('a');
    if (snapshot.kind !== 'state') throw new Error('fixture');
    snapshot.snapshot.captions.a = '{legacy unreadable';
    const source = history([snapshot], []);
    expect(parse(source)).toEqual(source);
    const copied = remapPersistedHistory(source, {
      draftId: 'copy',
      mapId: (id) => `copy-${id}`,
      mapPath: () => {
        throw new Error('No parsed file to remap');
      },
    });
    const copiedSnapshot = copied.past[0];
    if (copiedSnapshot.kind !== 'state') throw new Error('fixture');
    expect(copiedSnapshot.snapshot.captions['copy-a']).toBe('{legacy unreadable');
    expect(parsePersistedHistory(JSON.stringify(copied), 'copy')).toEqual(copied);
  });

  it('remaps all nested identities and media without changing the source object', () => {
    const source = compoundHistory();
    const before = JSON.stringify(source);
    const copied = remapPersistedHistory(source, {
      draftId: 'copy',
      mapId: (id) => `copy-${id}`,
      mapPath: (file) => file.replace(/^drafts\/[^/]+\//, 'drafts/copy/'),
      checkpoint: 'copied-checkpoint',
    });
    expect(JSON.stringify(source)).toBe(before);
    expect(copied.checkpoint).toBe('copied-checkpoint');
    expect(historyClipIds(copied)).toEqual(
      new Set([...historyClipIds(source)].map((id) => `copy-${id}`)),
    );
    expect([...historyMediaPaths(copied)].every((file) => file.startsWith('drafts/copy/'))).toBe(
      true,
    );
    expect(JSON.stringify(copied)).not.toContain('batchKey');
    expect(parsePersistedHistory(JSON.stringify(copied), 'copy')).toEqual(copied);
    const next = copied.future[0];
    if (next.kind !== 'added' || !next.taken) throw new Error('fixture');
    expect(next.taken.rows[0].captionEdit).toContain('drafts/copy/segments/x.mp4');
    expect(next.taken.transcripts[0]).toMatchObject({
      segmentId: 'copy-x',
      file: 'drafts/copy/segments/x.mp4',
      words: '[]',
    });
    expect(next.taken.replaced?.[0].draftId).toBe('copy');
  });
});

describe('Undo retention', () => {
  it('bounds the combined stacks, evicting oldest Undo steps first', () => {
    const past = Array.from({ length: 90 }, (_, index) => state(`past-${index}`));
    const future = Array.from({ length: 20 }, (_, index) => state(`future-${index}`));
    const result = trimPersistedHistory(history(past, future), () => 1);
    expect(result.past).toEqual(past.slice(10));
    expect(result.future).toEqual(future);
    expect(parse(result)).toEqual(result);
  });

  it('evicts video by unique retained bytes and excludes files live rows still need', () => {
    const value = history([], [added('far'), added('near')]);
    const result = trimPersistedHistory(value, (file) =>
      file.endsWith('.mp4') ? HISTORY_MAX_MEDIA_BYTES : null,
    );
    expect(result.future).toEqual([value.future[1]]);
    const live = new Set([path('far'), path('near')]);
    expect(
      trimPersistedHistory(
        value,
        (file) => (file.endsWith('.mp4') ? HISTORY_MAX_MEDIA_BYTES : null),
        live,
      ).future,
    ).toEqual(value.future);
  });

  it('does not double-count a source shared by several history steps', () => {
    const first = added('x');
    const second = added('x');
    expect(
      trimPersistedHistory(history([], [first, second]), (file) =>
        file.endsWith('.mp4') ? HISTORY_MAX_MEDIA_BYTES : null,
      ).future,
    ).toHaveLength(2);
  });

  it('keeps only the contiguous usable chain nearest the present when a source is missing', () => {
    const value = history([state('unrelated')], [added('far'), added('missing'), added('near')]);
    const result = trimPersistedHistory(value, (file) => (file === path('missing') ? null : 1));
    expect(result.past).toEqual(value.past);
    expect(result.future).toEqual([value.future[2]]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'treats invalid file size %s as unavailable',
    (size) => {
      expect(trimPersistedHistory(history([], [added('x')]), () => size).future).toEqual([]);
    },
  );

  it('preserves replay when only a regenerable thumbnail is missing', () => {
    const value = history([], [added('x')]);
    expect(trimPersistedHistory(value, (file) => (file.endsWith('.jpg') ? null : 1))).toEqual(
      value,
    );
  });

  it('also bounds JSON size, dropping oversized snapshots without changing the source', () => {
    const large = state('large');
    if (large.kind !== 'state') throw new Error('fixture');
    large.snapshot.edits.large = 'a'.repeat(HISTORY_MAX_JSON_BYTES);
    const value = history([large, state('near')], []);
    expect(trimPersistedHistory(value, () => 1).past).toEqual([value.past[1]]);
    expect(value.past).toHaveLength(2);
  });
});
