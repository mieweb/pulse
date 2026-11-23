import { describe, expect, it } from '@jest/globals';

import { checkOpenRequest, CONTEXT_MAX_BYTES, contextProblem, LABEL_MAX } from './validate';

const context = { key: 'ticket:t-42', kind: 'ticket', id: 'T-42', label: 'Fix login' };

describe('checkOpenRequest', () => {
  it('accepts a record request with a context', () => {
    const c = checkOpenRequest({ entry: 'record', context, requestId: 'r-1' }, 'file');
    expect(c).toEqual({ ok: true, request: { entry: 'record', context, requestId: 'r-1' } });
  });

  it('record without a context is invalid_options', () => {
    for (const raw of [{ entry: 'record' }, { entry: 'record', context: null }]) {
      expect(checkOpenRequest(raw, 'file')).toMatchObject({ ok: false, code: 'invalid_options' });
    }
  });

  it('record with a context missing a required field is invalid_options', () => {
    for (const field of ['key', 'kind', 'id', 'label'] as const) {
      const partial: Record<string, unknown> = { ...context };
      delete partial[field];
      const c = checkOpenRequest({ entry: 'record', context: partial }, 'file');
      expect(c).toMatchObject({ ok: false, code: 'invalid_options' });
      if (!c.ok) expect(c.message).toContain(`context.${field}`);
    }
  });

  it('a newer optional field is accepted and dropped (N+1); the context is kept whole', () => {
    const newerContext = {
      ...context,
      uploadType: { id: 'ticket.video', version: 2, nextThing: 1 },
      hint: 'x',
    };
    const c = checkOpenRequest(
      {
        entry: 'record',
        context: newerContext,
        draft: 'new',
        theme: { accent: '#3366ff', shimmer: true },
        futureOption: { anything: [1, 2] },
      },
      'file',
    );
    expect(c).toEqual({
      ok: true,
      request: {
        entry: 'record',
        context: newerContext,
        draft: 'new',
        theme: { accent: '#3366ff' },
      },
    });
  });

  it('a context over 8 KB is rejected; one at the limit is not', () => {
    const at = (bytes: number) => {
      const base = JSON.stringify({ ...context, data: '' }).length;
      return { ...context, data: 'a'.repeat(bytes - base) };
    };
    expect(checkOpenRequest({ entry: 'record', context: at(CONTEXT_MAX_BYTES) }, 'file').ok).toBe(
      true,
    );
    const over = checkOpenRequest({ entry: 'record', context: at(CONTEXT_MAX_BYTES + 1) }, 'file');
    expect(over).toMatchObject({ ok: false, code: 'invalid_options' });
  });

  it('counts the 8 KB in UTF-8 bytes, not characters', () => {
    // 3000 × 'é' is 3000 characters but 6000 bytes; twice that is over the cap.
    const wide = { ...context, data: 'é'.repeat(3000) };
    expect(checkOpenRequest({ entry: 'record', context: wide }, 'file').ok).toBe(true);
    const wider = { ...context, data: 'é'.repeat(4500) };
    expect(checkOpenRequest({ entry: 'record', context: wider }, 'file').ok).toBe(false);
    // An emoji is one surrogate pair: 4 bytes.
    const emoji = { ...context, data: '😀'.repeat(2100) };
    expect(checkOpenRequest({ entry: 'record', context: emoji }, 'file').ok).toBe(false);
  });

  it('checks the key and the label', () => {
    const bad = [
      { ...context, key: 'Ticket:T-42' },
      { ...context, key: 'ticket:t 42' },
      { ...context, key: `ticket:${'a'.repeat(128)}` },
      { ...context, label: '   ' },
      { ...context, label: 'x'.repeat(LABEL_MAX + 1) },
      { ...context, uploadType: { id: 'ticket.video' } },
      { ...context, uploadType: { id: 'ticket.video', version: 1, confirmSend: 'yes' } },
      { ...context, uploadType: { id: 'ticket.video', version: 1, limits: { maxDurationMs: -1 } } },
    ];
    for (const c of bad) expect(contextProblem(c)).not.toBeNull();
    expect(contextProblem({ ...context, label: 'x'.repeat(LABEL_MAX) })).toBeNull();
    expect(contextProblem(context)).toBeNull();
  });

  it('checks draft, requestId and theme types', () => {
    const bad = [
      { entry: 'record', context, draft: 'old' },
      { entry: 'record', context, draft: { continue: '' } },
      { entry: 'record', context, requestId: '../x' },
      { entry: 'record', context, requestId: 'a'.repeat(65) },
      { entry: 'record', context, theme: 'dark' },
      { entry: 'record', context, theme: { appearance: 'dim' } },
      { entry: 'record', context, theme: { accent: 'red' } },
      { entry: 'record', context, theme: { buttonRadius: -2 } },
    ];
    for (const raw of bad) {
      expect(checkOpenRequest(raw, 'file')).toMatchObject({ ok: false, code: 'invalid_options' });
    }
    const continued = checkOpenRequest(
      { entry: 'record', context, draft: { continue: 'd9', extra: 1 }, requestId: null },
      'file',
    );
    expect(continued).toEqual({
      ok: true,
      request: { entry: 'record', context, draft: { continue: 'd9' } },
    });
  });

  it('edit and export need a draftId', () => {
    expect(checkOpenRequest({ entry: 'edit', draftId: 'd1', clipId: 's2' }, 'file')).toEqual({
      ok: true,
      request: { entry: 'edit', draftId: 'd1', clipId: 's2' },
    });
    expect(checkOpenRequest({ entry: 'export', draftId: 'd1' }, 'file')).toEqual({
      ok: true,
      request: { entry: 'export', draftId: 'd1' },
    });
    for (const raw of [
      { entry: 'edit' },
      { entry: 'export', draftId: 7 },
      { entry: 'edit', draftId: '' },
    ]) {
      expect(checkOpenRequest(raw, 'file')).toMatchObject({ ok: false, code: 'invalid_options' });
    }
  });

  it('an unknown or missing entry, or a request that is not an object, is invalid_options', () => {
    for (const raw of [{ entry: 'full' }, {}, null, 'record', [{ entry: 'record' }]]) {
      expect(checkOpenRequest(raw, 'file')).toMatchObject({ ok: false, code: 'invalid_options' });
    }
  });

  it("uploadMode 'pulse' (also the default) runs, like 'file'; anything else is invalid_options", () => {
    const raw = { entry: 'record', context };
    for (const mode of ['pulse', undefined, null, 'file']) {
      expect(checkOpenRequest(raw, mode)).toMatchObject({ ok: true, request: { entry: 'record' } });
    }
    expect(checkOpenRequest(raw)).toMatchObject({ ok: true });
    expect(checkOpenRequest(raw, 'ftp')).toMatchObject({ ok: false, code: 'invalid_options' });
  });

  it('a malformed request is invalid_options even in pulse mode', () => {
    expect(checkOpenRequest({ entry: 'record' }, 'pulse')).toMatchObject({
      ok: false,
      code: 'invalid_options',
    });
  });
});
