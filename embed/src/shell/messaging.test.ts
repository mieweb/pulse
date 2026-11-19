import { describe, expect, it } from '@jest/globals';

import { createChannel, createUiSender, type Message } from './messaging';

/** A transport that records what Pulse sends and lets the test play native. */
function fakeTransport() {
  const sent: Message[] = [];
  let deliver: ((m: Message) => void) | null = null;
  let listens = 0;
  return {
    sent,
    get listens() {
      return listens;
    },
    transport: {
      send: (m: Message) => void sent.push(m),
      listen: (onMessage: (m: Message) => void) => {
        listens++;
        deliver = onMessage;
        return () => {
          deliver = null;
        };
      },
    },
    /** Native sends `message`; resolves once the reply has had its turn. */
    async native(message: Message) {
      deliver?.(message);
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('pulse.cmd ⇄ pulse.reply', () => {
  it('answers a registered command with its result, null for none', async () => {
    const t = fakeTransport();
    const channel = createChannel(t.transport);
    const seen: unknown[] = [];
    channel.handle('close', (args, callId) => {
      seen.push([args, callId]);
    });
    channel.handle('echo', async (args) => args.value);

    await t.native({ type: 'pulse.cmd', callId: 'n-1', method: 'close', args: { reason: 'host' } });
    await t.native({ type: 'pulse.cmd', callId: 'n-2', method: 'echo', args: { value: [1, 'a'] } });

    expect(seen).toEqual([[{ reason: 'host' }, 'n-1']]);
    expect(t.sent).toEqual([
      { type: 'pulse.reply', callId: 'n-1', ok: true, result: null },
      { type: 'pulse.reply', callId: 'n-2', ok: true, result: [1, 'a'] },
    ]);
  });

  it('replies method.unsupported for a command nothing answers', async () => {
    const t = fakeTransport();
    createChannel(t.transport).handle('close', () => null);
    await t.native({ type: 'pulse.cmd', callId: 'n-3', method: 'releaseLibrary', args: {} });
    expect(t.sent).toEqual([
      {
        type: 'pulse.reply',
        callId: 'n-3',
        ok: false,
        error: {
          code: 'method.unsupported',
          message: 'Pulse doesn’t answer “releaseLibrary” here.',
          recoverable: false,
          callId: 'n-3',
        },
      },
    ]);
  });

  it('turns a handler that throws into an error reply', async () => {
    const t = fakeTransport();
    createChannel(t.transport).handle('close', async () => {
      throw new Error('no flow');
    });
    await t.native({ type: 'pulse.cmd', callId: 'n-4', method: 'close' });
    expect(t.sent).toEqual([
      {
        type: 'pulse.reply',
        callId: 'n-4',
        ok: false,
        error: { code: 'unknown', message: 'no flow', recoverable: false, callId: 'n-4' },
      },
    ]);
  });

  it('ignores other messages and commands without a callId', async () => {
    const t = fakeTransport();
    createChannel(t.transport).handle('close', () => null);
    await t.native({ type: 'pulse.respond', hostCallId: 'h1' });
    await t.native({ type: 'pulse.cmd', method: 'close' });
    expect(t.sent).toEqual([]);
  });

  it('stops answering once the flow unregisters, without dropping a newer handler', async () => {
    const t = fakeTransport();
    const channel = createChannel(t.transport);
    const first = channel.handle('close', () => 'first');
    const second = channel.handle('close', () => 'second');
    first(); // the old flow unmounting after the new one registered
    await t.native({ type: 'pulse.cmd', callId: 'n-5', method: 'close' });
    second();
    await t.native({ type: 'pulse.cmd', callId: 'n-6', method: 'close' });
    expect(t.sent.map((m) => [m.callId, m.ok, m.result ?? null])).toEqual([
      ['n-5', true, 'second'],
      ['n-6', false, null],
    ]);
    expect(t.listens).toBe(1); // one listener for the runtime's lifetime
  });
});

describe('the messages Pulse sends', () => {
  it('shapes pulse.result, pulse.error, pulse.event and pulse.ui as §8.1 does', () => {
    const t = fakeTransport();
    const channel = createChannel(t.transport);
    channel.result('req-1');
    channel.error('req-2', 'no roots');
    channel.event('draftsChanged', { namespace: 'ns', ids: ['d1'] });
    channel.ui({ statusBar: 'light', hasTake: true });
    expect(t.sent).toEqual([
      { type: 'pulse.result', requestId: 'req-1' },
      { type: 'pulse.error', requestId: 'req-2', message: 'no roots' },
      { type: 'pulse.event', name: 'draftsChanged', payload: { namespace: 'ns', ids: ['d1'] } },
      { type: 'pulse.ui', statusBar: 'light', hasTake: true },
    ]);
  });
});

describe('createUiSender', () => {
  it('sends a field only when it changes', () => {
    const sent: object[] = [];
    const ui = createUiSender((f) => void sent.push(f));
    ui({ statusBar: 'light', statusBarHidden: false });
    ui({ statusBar: 'light' });
    ui({ hasTake: false });
    ui({ statusBar: 'dark', hasTake: false, statusBarHidden: undefined });
    ui({ hasTake: true });
    expect(sent).toEqual([
      { statusBar: 'light', statusBarHidden: false },
      { hasTake: false },
      { statusBar: 'dark' },
      { hasTake: true },
    ]);
  });
});
