import { describe, expect, it, jest } from '@jest/globals';

import {
  CONTEXT_JSON_MAX_BYTES,
  hostContextColumns,
  hostContextOf,
  LibraryError,
  utf8Length,
  type HostContext,
} from './host-context';

const TICKET: HostContext = {
  key: 'ticket:t-42',
  kind: 'ticket',
  id: 'T-42',
  label: 'Fix login',
  data: { type: 'ticket.video', target: { kind: 'ticket', ticketId: 'T-42' } },
};
const TYPE = { id: 'ticket.video', version: 1, sendLabel: 'Send to Fix login' };

/** The LibraryError `run` throws (fails the test if it throws nothing, or something else). */
function refusal(run: () => unknown): LibraryError {
  try {
    run();
  } catch (e) {
    expect((e as Error).name).toBe('LibraryError'); // a class from an isolated module too
    return e as LibraryError;
  }
  throw new Error('expected a refusal');
}

describe('hostContextColumns', () => {
  it('stores the key and label in their columns, the rest and the upload type as JSON', () => {
    expect(hostContextColumns(TICKET, TYPE)).toEqual({
      contextKey: 'ticket:t-42',
      contextLabel: 'Fix login',
      contextJson: JSON.stringify({
        kind: 'ticket',
        id: 'T-42',
        data: TICKET.data,
        label: 'Fix login',
      }),
      uploadTypeJson: JSON.stringify(TYPE),
    });
  });

  it('takes the context’s own upload type when none is given, and none when it has none', () => {
    const columns = hostContextColumns({ ...TICKET, uploadType: TYPE });
    expect(columns.uploadTypeJson).toBe(JSON.stringify(TYPE));
    expect(JSON.parse(columns.contextJson)).not.toHaveProperty('uploadType');
    expect(hostContextColumns(TICKET).uploadTypeJson).toBeNull();
  });

  it('gives back the context it stored, upload type included', () => {
    expect(hostContextOf(hostContextColumns(TICKET, TYPE))).toEqual({
      ...TICKET,
      uploadType: TYPE,
    });
    expect(hostContextOf(hostContextColumns(TICKET))).toEqual(TICKET);
    const none = { contextKey: null, contextLabel: null, contextJson: null, uploadTypeJson: null };
    expect(hostContextOf(none)).toBeNull();
    expect(hostContextOf({ ...hostContextColumns(TICKET), contextJson: '{not json' })).toBeNull();
  });

  it.each([
    ['upper case', 'ticket:T-42'],
    ['no kind', 't-42'],
    ['an empty id', 'ticket:'],
    ['a space', 'ticket:t 42'],
    ['129 characters', `ticket:${'x'.repeat(122)}`],
  ])('refuses a key with %s', (_, key) => {
    const e = refusal(() => hostContextColumns({ ...TICKET, key }));
    expect(e.code).toBe('invalid_options');
  });

  it('takes a key of exactly 128 characters, colons in the id included', () => {
    const key = `clock:${'a:'.repeat(60)}aa`;
    expect(key).toHaveLength(128);
    expect(hostContextColumns({ ...TICKET, key }).contextKey).toBe(key);
  });

  it('refuses a blank label or one over 120 characters, counting characters, not bytes', () => {
    for (const label of ['', '   ', 'x'.repeat(121)]) {
      expect(refusal(() => hostContextColumns({ ...TICKET, label })).code).toBe('invalid_options');
    }
    expect(refusal(() => hostContextColumns({ ...TICKET, label: undefined as never })).code).toBe(
      'invalid_options',
    );
    const emoji = '🎬'.repeat(120); // 240 UTF-16 units, 120 characters
    expect(hostContextColumns({ ...TICKET, label: emoji }).contextLabel).toBe(emoji);
  });

  it('refuses a context or an upload type over 8 KB as UTF-8 JSON', () => {
    // 'é' is 2 bytes: under 8192 characters, over 8192 bytes.
    const big = { note: 'é'.repeat(4100) };
    expect(JSON.stringify(big).length).toBeLessThan(CONTEXT_JSON_MAX_BYTES);
    expect(refusal(() => hostContextColumns({ ...TICKET, data: big })).code).toBe(
      'invalid_options',
    );
    expect(refusal(() => hostContextColumns(TICKET, { ...TYPE, meta: big })).code).toBe(
      'invalid_options',
    );
    const fits = { note: 'x'.repeat(8000) };
    expect(hostContextColumns(TICKET, { ...TYPE, meta: fits }).uploadTypeJson).toContain('xxx');
  });

  it('refuses what isn’t JSON, and a context that isn’t an object', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(refusal(() => hostContextColumns({ ...TICKET, data: cyclic })).code).toBe(
      'invalid_options',
    );
    expect(refusal(() => hostContextColumns(null as never)).code).toBe('invalid_options');
  });
});

describe('utf8Length', () => {
  it('counts UTF-8 bytes as Buffer does', () => {
    for (const s of ['', 'abc', 'é', '€', '🎬', 'a🎬é€\ud800x']) {
      expect([s, utf8Length(s)]).toEqual([s, Buffer.byteLength(s, 'utf8')]);
    }
  });
});

describe('a library a newer Pulse migrated', () => {
  it('lets edits through until the library is marked newer, then refuses them', () => {
    jest.isolateModules(() => {
      const h = jest.requireActual<typeof import('./host-context')>('./host-context');
      expect(h.libraryNewerSchema()).toBe(false);
      expect(() => h.assertEditable()).not.toThrow();
      h.markNewerSchema();
      expect(h.libraryNewerSchema()).toBe(true);
      const e = refusal(() => h.assertEditable());
      expect(e.code).toBe('storage.newer_schema');
    });
  });
});
