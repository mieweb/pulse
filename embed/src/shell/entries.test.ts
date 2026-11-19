import { describe, expect, it } from '@jest/globals';
import type { EntryName, PulseContext } from '@mieweb/pulse-embed';

import { initFlow } from '../flow/reducer';
import { ENTRIES, isEntryName, planOpen, type EmbedProps } from './entries';

const context: PulseContext = {
  key: 'ticket:t-42',
  kind: 'ticket',
  id: 'T-42',
  label: 'Fix login',
};
const FILE_MODE = { uploadMode: 'file' };

/** The facade's initial props for `request`, in the 'file' mode PR1 runs. */
const props = (request: unknown, config: unknown = FILE_MODE): EmbedProps => ({
  requestId: 'req-1',
  request,
  documentsDir: '/docs',
  cachesDir: '/caches',
  config,
});

describe('the entry registry', () => {
  it('opens each entry on its own first screen, and none on Drafts', () => {
    expect(Object.fromEntries(Object.entries(ENTRIES).map(([e, s]) => [e, s.firstScreen]))).toEqual(
      { record: 'recorder', edit: 'editor', export: 'export' },
    );
    expect(Object.values(ENTRIES).map((s) => s.firstScreen)).not.toContain('drafts');
  });

  it('is the screen the flow stack starts with', () => {
    const requests = {
      record: { entry: 'record', context },
      edit: { entry: 'edit', draftId: 'd1' },
      export: { entry: 'export', draftId: 'd1' },
    } as const;
    for (const entry of Object.keys(ENTRIES) as EntryName[]) {
      expect(initFlow('r', requests[entry]).stack).toEqual([ENTRIES[entry].firstScreen]);
    }
  });

  it('names the draft an entry opens: none for a new recording', () => {
    const plan = (request: unknown) => {
      const p = planOpen(props(request));
      if (!p.ok) throw new Error(p.error.message);
      return p.draftId;
    };
    expect(plan({ entry: 'record', context })).toBeNull();
    expect(plan({ entry: 'record', context, draft: 'new' })).toBeNull();
    expect(plan({ entry: 'record', context, draft: { continue: 'd7' } })).toBe('d7');
    expect(plan({ entry: 'edit', draftId: 'd2', clipId: 'c1' })).toBe('d2');
    expect(plan({ entry: 'export', draftId: 'd3' })).toBe('d3');
  });

  it('knows only its own entry names', () => {
    expect(['record', 'edit', 'export'].every(isEntryName)).toBe(true);
    for (const name of ['full', 'drafts', 'toString', '__proto__', '', 3, null]) {
      expect(isEntryName(name)).toBe(false);
    }
  });
});

describe('planOpen', () => {
  it('refuses an entry Pulse doesn’t have as invalid_options, with no entry to report', () => {
    for (const entry of ['full', 'drafts', 'constructor']) {
      const plan = planOpen(props({ entry }));
      expect(plan).toEqual({
        ok: false,
        entry: null,
        error: {
          code: 'invalid_options',
          message: `Pulse has no entry named ${JSON.stringify(entry)}.`,
          recoverable: false,
          callId: '',
          requestId: 'req-1',
        },
      });
    }
    expect(planOpen(props({}))).toMatchObject({
      ok: false,
      entry: null,
      error: { code: 'invalid_options', message: 'open needs an entry.' },
    });
    expect(planOpen(props(undefined))).toMatchObject({
      ok: false,
      error: { code: 'invalid_options' },
    });
  });

  it('refuses record without a context, naming the entry for its result', () => {
    expect(planOpen(props({ entry: 'record' }))).toMatchObject({
      ok: false,
      entry: 'record',
      error: { code: 'invalid_options', message: 'record needs a context.' },
    });
  });

  it('refuses uploadMode pulse (the default) as unsupported in PR1', () => {
    for (const config of [null, {}, { uploadMode: 'pulse' }]) {
      expect(planOpen(props({ entry: 'edit', draftId: 'd1' }, config))).toMatchObject({
        ok: false,
        entry: 'edit',
        error: { code: 'unsupported' },
      });
    }
  });

  it('runs a valid request under the facade’s requestId, ignoring fields it doesn’t know', () => {
    const plan = planOpen(
      props(
        { entry: 'record', context, requestId: 'other', newerField: 1 },
        {
          ...FILE_MODE,
          policy: { allowShare: false },
        },
      ),
    );
    expect(plan).toEqual({
      ok: true,
      requestId: 'req-1',
      request: { requestId: 'req-1', entry: 'record', context },
      draftId: null,
      config: { uploadMode: 'file', policy: { allowShare: false } },
    });
  });
});
