import { describe, expect, it, jest } from '@jest/globals';

import type { JobState } from '@/db/upload-jobs';

import { createChannel, type CommandArgs, type Message } from '../shell/messaging';
import {
  commandHandlers,
  routeCommands,
  WRITE_METHODS,
  type CommandDeps,
  type DraftLock,
} from './router';

// upload-jobs.ts (the lock states) imports the database client; the router reads nothing from it.
jest.mock('@/db/client', () => ({ db: {} }));

const CONTEXT = { key: 'ticket:42', kind: 'ticket', id: '42', label: 'Fix login' };

/** A library of drafts by id, and a record of what the commands did to it, in order. */
function fakeLibrary(
  drafts: Record<string, Partial<DraftLock>> = {},
  opts: { receipts?: string[]; newerSchema?: boolean; held?: string; mode?: 'pulse' | 'file' } = {},
) {
  const calls: string[] = [];
  const rows = new Map(
    Object.entries(drafts).map(([id, d]) => [id, { jobState: null, clockBound: false, ...d }]),
  );
  const deps: CommandDeps = {
    draft: (id) => rows.get(id) ?? null,
    hasReceipt: (id) => opts.receipts?.includes(id) ?? false,
    newerSchema: () => opts.newerSchema ?? false,
    heldDraft: () => opts.held ?? null,
    uploadMode: () => opts.mode ?? 'pulse',
    cancelJob: (id, reason) => void calls.push(`cancelJob ${id} ${reason}`),
    rename: async (id, name) => void calls.push(`rename ${id} ${name}`),
    remove: async (id) => void calls.push(`remove ${id}`),
    setContext: async (id, context) => void calls.push(`setContext ${id} ${context.key}`),
    send: async (id) => {
      calls.push(`send ${id}`);
      return { clientKey: `ck-${id}`, draftKey: `dk-${id}`, sentAt: 1 };
    },
    retireFile: (id) => void calls.push(`retireFile ${id}`),
    recheck: (id) => void calls.push(`recheck ${id}`),
    dismissReceipt: (id) => {
      calls.push(`dismiss ${id}`);
      return opts.receipts?.includes(id) ?? false;
    },
    resumeOutbox: async () => void calls.push('resumeOutbox'),
    changed: async (ids) => void calls.push(`changed ${ids.join(',')}`),
  };
  return { deps, calls, handlers: commandHandlers(deps) };
}

/** The handler's outcome: 'ok', or the refusal's code (and reason). */
async function outcome(run: unknown): Promise<string> {
  try {
    await run;
    return 'ok';
  } catch (e) {
    const { code, reason } = e as { code?: string; reason?: string };
    return reason ? `${code}/${reason}` : String(code);
  }
}

const STATES: (JobState | null)[] = [
  null,
  'preparing',
  'queued',
  'uploading',
  'delivering',
  'needs_credentials',
  'failed',
];

describe('the lock matrix (PLAN §6.1)', () => {
  // Expected outcome per job state, in STATES order: null, preparing, queued, uploading,
  // delivering, needs_credentials, failed.
  const L = 'draft.locked';
  const matrix: [string, CommandArgs, string[]][] = [
    ['renameDraft', { id: 'd1', name: 'New' }, ['ok', L, 'ok', L, L, 'ok', 'ok']],
    ['deleteDraft', { id: 'd1' }, ['ok', L, 'ok', L, L, 'ok', 'ok']],
    ['setDraftContext', { id: 'd1', context: CONTEXT }, ['ok', L, 'ok', L, L, 'ok', 'ok']],
    ['upload', { id: 'd1' }, ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']],
    ['cancelUpload', { id: 'd1' }, ['ok', L, 'ok', 'ok', L, 'ok', 'ok']],
  ];

  for (const [method, args, expected] of matrix) {
    it(`${method}: ${expected.join(' ')}`, async () => {
      const got: string[] = [];
      for (const jobState of STATES) {
        const { handlers } = fakeLibrary({ d1: { jobState } });
        got.push(await outcome(handlers[method as keyof typeof handlers](args, 'c-1')));
      }
      expect(got).toEqual(expected);
    });
  }

  it("retireDraft in 'file' mode locks while a job prepares, uploads or delivers", async () => {
    const got: string[] = [];
    for (const jobState of STATES) {
      const { handlers } = fakeLibrary({ d1: { jobState } }, { mode: 'file' });
      got.push(await outcome(handlers.retireDraft({ id: 'd1' }, 'c-1')));
    }
    expect(got).toEqual(['ok', L, 'ok', L, L, 'ok', 'ok']);
  });

  it('an edit, a move or a delete takes a queued, paused or failed job out first', async () => {
    for (const jobState of ['queued', 'needs_credentials', 'failed'] as const) {
      const lib = fakeLibrary({ d1: { jobState } });
      await lib.handlers.renameDraft({ id: 'd1', name: ' Retake ' }, 'c-1');
      await lib.handlers.setDraftContext({ id: 'd1', context: CONTEXT }, 'c-2');
      await lib.handlers.deleteDraft({ id: 'd1' }, 'c-3');
      expect(lib.calls).toEqual([
        'cancelJob d1 edited',
        'rename d1 Retake',
        'changed d1',
        'cancelJob d1 edited',
        'setContext d1 ticket:42',
        'changed d1',
        'cancelJob d1 deleted',
        'remove d1',
        'changed d1',
      ]);
    }
  });

  it('a draft without a job is edited without touching the outbox', async () => {
    const lib = fakeLibrary({ d1: {} });
    await lib.handlers.renameDraft({ id: 'd1', name: '' }, 'c-1');
    expect(lib.calls).toEqual(['rename d1 null', 'changed d1']);
  });

  it('a locked draft is left exactly as it was', async () => {
    const lib = fakeLibrary({ d1: { jobState: 'uploading' } });
    await outcome(lib.handlers.renameDraft({ id: 'd1', name: 'x' }, 'c-1'));
    await outcome(lib.handlers.deleteDraft({ id: 'd1' }, 'c-2'));
    await outcome(lib.handlers.setDraftContext({ id: 'd1', context: CONTEXT }, 'c-3'));
    expect(lib.calls).toEqual([]);
  });

  it('cancelUpload cancels the job, and does nothing for a draft with none', async () => {
    const queued = fakeLibrary({ d1: { jobState: 'uploading' } });
    await queued.handlers.cancelUpload({ id: 'd1' }, 'c-1');
    expect(queued.calls).toEqual(['cancelJob d1 canceled', 'changed d1']);
    const none = fakeLibrary({ d1: {} });
    await none.handlers.cancelUpload({ id: 'd1' }, 'c-1');
    expect(none.calls).toEqual([]);
  });

  it('a write on the draft the open flow holds is draft.locked; others go ahead', async () => {
    const lib = fakeLibrary({ d1: {}, d2: {} }, { held: 'd1' });
    for (const method of ['renameDraft', 'deleteDraft', 'upload', 'cancelUpload'] as const) {
      expect(await outcome(lib.handlers[method]({ id: 'd1', name: 'x' }, 'c-1'))).toBe(L);
    }
    expect(await outcome(lib.handlers.upload({ id: 'd2' }, 'c-2'))).toBe('ok');
  });
});

describe('clock-bound drafts (O13)', () => {
  it('setDraftContext refuses with reason clock_bound and leaves the Send queued', async () => {
    const lib = fakeLibrary({ d1: { jobState: 'queued', clockBound: true } });
    expect(await outcome(lib.handlers.setDraftContext({ id: 'd1', context: CONTEXT }, 'c-1'))).toBe(
      'draft.locked/clock_bound',
    );
    expect(lib.calls).toEqual([]);
  });

  it('setDraftContext refuses clock_bound with no job too (a re-Send keeps the clock)', async () => {
    const lib = fakeLibrary({ d1: { clockBound: true } });
    expect(await outcome(lib.handlers.setDraftContext({ id: 'd1', context: CONTEXT }, 'c-1'))).toBe(
      'draft.locked/clock_bound',
    );
  });

  it('deleteDraft still deletes, and the host cancels the intent', async () => {
    const lib = fakeLibrary({ d1: { jobState: 'queued', clockBound: true } });
    await lib.handlers.deleteDraft({ id: 'd1' }, 'c-1');
    expect(lib.calls).toEqual(['cancelJob d1 deleted', 'remove d1', 'changed d1']);
  });

  it('a rename is an edit, allowed', async () => {
    const lib = fakeLibrary({ d1: { clockBound: true } });
    expect(await outcome(lib.handlers.renameDraft({ id: 'd1', name: 'x' }, 'c-1'))).toBe('ok');
  });
});

describe('not_found, invalid_options and storage.newer_schema', () => {
  it('every draft command on a draft that does not exist is not_found', async () => {
    const lib = fakeLibrary();
    for (const method of [
      'renameDraft',
      'deleteDraft',
      'setDraftContext',
      'upload',
      'cancelUpload',
      'retireDraft',
      'dismissReceipt',
    ] as const) {
      const args = { id: 'gone', name: 'x', context: CONTEXT };
      expect([method, await outcome(lib.handlers[method](args, 'c-1'))]).toEqual([
        method,
        'not_found',
      ]);
    }
    expect(lib.calls).toEqual(['dismiss gone']);
  });

  it('retireDraft of a draft that already retired into a receipt is a no-op', async () => {
    const lib = fakeLibrary({}, { receipts: ['d1'] });
    expect(await outcome(lib.handlers.retireDraft({ id: 'd1' }, 'c-1'))).toBe('ok');
    expect(lib.calls).toEqual([]);
  });

  it("retireDraft: 'file' mode retires now, 'pulse' mode asks the status route again", async () => {
    const file = fakeLibrary({ d1: {} }, { mode: 'file' });
    await file.handlers.retireDraft({ id: 'd1' }, 'c-1');
    expect(file.calls).toEqual(['retireFile d1', 'changed d1']);
    const pulse = fakeLibrary({ d1: { jobState: 'delivering' } });
    await pulse.handlers.retireDraft({ id: 'd1' }, 'c-1');
    expect(pulse.calls).toEqual(['recheck d1']);
  });

  it('a missing id, a missing name and a context Pulse would refuse are invalid_options', async () => {
    const lib = fakeLibrary({ d1: { jobState: 'queued' } });
    expect(await outcome(lib.handlers.deleteDraft({}, 'c-1'))).toBe('invalid_options');
    expect(await outcome(lib.handlers.renameDraft({ id: 'd1' }, 'c-1'))).toBe('invalid_options');
    const bad = { ...CONTEXT, key: 'Not A Key' };
    expect(await outcome(lib.handlers.setDraftContext({ id: 'd1', context: bad }, 'c-1'))).toBe(
      'invalid_options',
    );
    expect(lib.calls).toEqual([]); // the queued Send stays queued
  });

  it('a newer schema refuses rename and move, but deletes and sends', async () => {
    const lib = fakeLibrary({ d1: {} }, { newerSchema: true });
    const args = { id: 'd1', name: 'x', context: CONTEXT };
    expect(await outcome(lib.handlers.renameDraft(args, 'c-1'))).toBe('storage.newer_schema');
    expect(await outcome(lib.handlers.setDraftContext(args, 'c-1'))).toBe('storage.newer_schema');
    expect(await outcome(lib.handlers.upload(args, 'c-1'))).toBe('ok');
    expect(await outcome(lib.handlers.deleteDraft(args, 'c-1'))).toBe('ok');
  });

  it("upload in 'file' mode is host_misconfigured: there is nothing to send to", async () => {
    const lib = fakeLibrary({ d1: {} }, { mode: 'file' });
    expect(await outcome(lib.handlers.upload({ id: 'd1' }, 'c-1'))).toBe('host_misconfigured');
  });
});

/** A transport that records what Pulse sends and lets the test play native. */
function fakeTransport() {
  const sent: Message[] = [];
  let deliver: ((m: Message) => void) | null = null;
  return {
    sent,
    transport: {
      send: (m: Message) => void sent.push(m),
      listen: (onMessage: (m: Message) => void) => {
        deliver = onMessage;
        return () => {
          deliver = null;
        };
      },
    },
    async native(message: Message) {
      deliver?.(message);
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('pulse.cmd → handler → pulse.reply', () => {
  // The channel logs each refusal; the replies are what's checked.
  jest.spyOn(console, 'log').mockImplementation(() => {});

  it('answers every write method, with Send’s keys as its result', async () => {
    const t = fakeTransport();
    const lib = fakeLibrary({ d1: {} });
    routeCommands(createChannel(t.transport), lib.handlers);
    await t.native({ type: 'pulse.cmd', callId: 'c-1', method: 'upload', args: { id: 'd1' } });
    expect(t.sent).toEqual([
      {
        type: 'pulse.reply',
        callId: 'c-1',
        ok: true,
        result: { clientKey: 'ck-d1', draftKey: 'dk-d1', sentAt: 1 },
      },
    ]);
    expect(Object.keys(lib.handlers).sort()).toEqual([...WRITE_METHODS].sort());
  });

  it('a refusal replies with its code, reason and draftId', async () => {
    const t = fakeTransport();
    const lib = fakeLibrary({ d1: { clockBound: true } });
    routeCommands(createChannel(t.transport), lib.handlers);
    await t.native({
      type: 'pulse.cmd',
      callId: 'c-2',
      method: 'setDraftContext',
      args: { id: 'd1', context: CONTEXT },
    });
    expect(t.sent).toEqual([
      {
        type: 'pulse.reply',
        callId: 'c-2',
        ok: false,
        error: {
          code: 'draft.locked',
          message: 'Draft d1 belongs to the clock action its Send confirmed.',
          recoverable: false,
          callId: 'c-2',
          reason: 'clock_bound',
          draftId: 'd1',
        },
      },
    ]);
  });

  it('an unknown method is method.unsupported', async () => {
    const t = fakeTransport();
    routeCommands(createChannel(t.transport), fakeLibrary().handlers);
    await t.native({ type: 'pulse.cmd', callId: 'c-3', method: 'renameEverything', args: {} });
    expect(t.sent).toEqual([
      {
        type: 'pulse.reply',
        callId: 'c-3',
        ok: false,
        error: {
          code: 'method.unsupported',
          message: 'Pulse doesn’t answer “renameEverything” here.',
          recoverable: false,
          callId: 'c-3',
        },
      },
    ]);
  });

  it('runs each command through `around` (the library gate), and stops on unregister', async () => {
    const t = fakeTransport();
    const lib = fakeLibrary();
    const seen: string[] = [];
    const stop = routeCommands(createChannel(t.transport), lib.handlers, async (method, run) => {
      seen.push(method);
      return run();
    });
    await t.native({ type: 'pulse.cmd', callId: 'c-4', method: 'resumeOutbox', args: {} });
    stop();
    await t.native({ type: 'pulse.cmd', callId: 'c-5', method: 'resumeOutbox', args: {} });
    expect(seen).toEqual(['resumeOutbox']);
    expect(lib.calls).toEqual(['resumeOutbox']);
    expect(t.sent.map((m) => [m.callId, m.ok])).toEqual([
      ['c-4', true],
      ['c-5', false],
    ]);
  });

  it("an error that isn't Pulse's own is unknown, and its code isn't passed on", async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const t = fakeTransport();
    const lib = fakeLibrary({ d1: {} });
    lib.deps.remove = async () => {
      throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE' });
    };
    routeCommands(createChannel(t.transport), commandHandlers(lib.deps));
    await t.native({ type: 'pulse.cmd', callId: 'c-6', method: 'deleteDraft', args: { id: 'd1' } });
    expect(t.sent[0]).toMatchObject({
      ok: false,
      error: { code: 'unknown', message: 'disk I/O error', recoverable: false },
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
