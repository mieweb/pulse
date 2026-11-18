import { describe, expect, it, jest } from '@jest/globals';

import {
  createPulseClient,
  type BridgeEvent,
  type ConfirmSendRequest,
  type HostResponse,
  type HostServices,
  type Json,
  type PulseAdapter,
  type UploadTarget,
} from '@mieweb/pulse-embed';

import { buildReply } from './envelope';
import { createHostRequestRouter } from './host-requests';

const flush = () => new Promise((r) => setTimeout(r, 0));

const target: UploadTarget = {
  uploadId: 'u-1',
  endpoint: 'https://host/pulsevault',
  artifactId: 'a-1',
  token: 'secret',
  expiresAt: 1763400060000,
  clientKey: 'i:d-1:0123456789abcdef',
};

const ctx = { key: 'clock:65a1', kind: 'clock', id: '65A1', label: 'Mon 9:02 session' };

function router(now = 1_000) {
  const responses: HostResponse[] = [];
  const respond = jest.fn(async (r: HostResponse) => {
    responses.push(r);
  });
  const r = createHostRequestRouter({ respond, now: () => now });
  return { r, responses, respond };
}

function services(over: Partial<HostServices> = {}): HostServices {
  return {
    getUploadTarget: jest.fn(async () => target),
    refreshUploadToken: jest.fn(async () => ({ token: 't2', expiresAt: 2 })),
    ...over,
  };
}

describe('host requests', () => {
  it('queues requests until setHostServices, then answers each one', async () => {
    const { r, responses } = router();
    r.handle({
      hostCallId: 'h-1',
      method: 'getUploadTarget',
      args: { draftId: 'd-1' },
      deadline: 5_000,
    });
    r.handle({
      hostCallId: 'h-2',
      method: 'refreshUploadToken',
      args: { uploadId: 'u-1' },
      deadline: 5_000,
    });
    await flush();
    expect(responses).toEqual([]);

    const s = services();
    r.setServices(s);
    await flush();
    expect(s.getUploadTarget).toHaveBeenCalledWith({ draftId: 'd-1' });
    expect(s.refreshUploadToken).toHaveBeenCalledWith({ uploadId: 'u-1' });
    expect(responses).toEqual([
      { hostCallId: 'h-1', result: target },
      { hostCallId: 'h-2', result: { token: 't2', expiresAt: 2 } },
    ]);

    // After registration, a request is answered straight away.
    r.handle({ hostCallId: 'h-3', method: 'getUploadTarget', args: {}, deadline: 5_000 });
    await flush();
    expect(responses[2]).toEqual({ hostCallId: 'h-3', result: target });
  });

  it("maps a handler's rejection to a HostServiceError code, anything else to host.unavailable", async () => {
    const { r, responses } = router();
    r.setServices(
      services({
        getUploadTarget: async () => {
          throw { code: 'destination.gone', message: 'Ticket not found' };
        },
        refreshUploadToken: async () => {
          throw new TypeError('fetch failed');
        },
      }),
    );
    r.handle({ hostCallId: 'h-1', method: 'getUploadTarget', args: {} });
    r.handle({ hostCallId: 'h-2', method: 'refreshUploadToken', args: {} });
    r.handle({
      hostCallId: 'h-3',
      method: 'getUploadTarget',
      args: {},
    });
    await flush();
    expect(responses).toEqual([
      { hostCallId: 'h-1', error: { code: 'destination.gone', message: 'Ticket not found' } },
      { hostCallId: 'h-2', error: { code: 'host.unavailable', message: 'fetch failed' } },
      { hostCallId: 'h-3', error: { code: 'destination.gone', message: 'Ticket not found' } },
    ]);
  });

  it('keeps every HostServiceError code and turns an unknown one into host.unavailable', async () => {
    const codes = [
      'destination.gone',
      'upload.refused',
      'no_account',
      'host.unavailable',
      'upload.too_large',
    ];
    const { r, responses } = router();
    let i = 0;
    const all = [...codes, 'teapot'];
    r.setServices(
      services({
        getUploadTarget: async () => {
          throw { code: all[i++], message: 'm' };
        },
      }),
    );
    for (const _ of all) r.handle({ hostCallId: `h-${_}`, method: 'getUploadTarget', args: {} });
    await flush();
    expect(responses.map((x) => x.error?.code)).toEqual([...codes, 'host.unavailable']);
  });

  it('routes confirmSend to its handler', async () => {
    const { r, responses } = router();
    const confirmSend = jest.fn(async (_req: ConfirmSendRequest) => ({
      confirmedAt: 1763400000500,
    }));
    r.setServices(services({ confirmSend }));
    const args = {
      draftId: 'd-1',
      draftKey: 'i:d-1',
      context: ctx,
      uploadType: { id: 'clock.wrapup', version: 1, confirmSend: true },
      sentAt: 1763400000000,
      bytes: 1234,
    };
    r.handle({ hostCallId: 'h-9', method: 'confirmSend', args });
    await flush();
    expect(confirmSend).toHaveBeenCalledWith(args);
    expect(responses).toEqual([{ hostCallId: 'h-9', result: { confirmedAt: 1763400000500 } }]);
  });

  it('answers a missing optional handler: releaseUploadTarget null, confirmSend host.unavailable', async () => {
    const { r, responses } = router();
    r.setServices(services());
    r.handle({ hostCallId: 'h-1', method: 'releaseUploadTarget', args: { uploadId: 'u-1' } });
    r.handle({ hostCallId: 'h-2', method: 'confirmSend', args: {} });
    r.handle({ hostCallId: 'h-3', method: 'teleport', args: {} });
    r.handle({ hostCallId: 'h-4', method: 'toString', args: {} });
    await flush();
    expect(responses).toEqual([
      { hostCallId: 'h-1', result: null },
      { hostCallId: 'h-2', error: { code: 'host.unavailable', message: expect.any(String) } },
      { hostCallId: 'h-3', error: { code: 'host.unavailable', message: expect.any(String) } },
      { hostCallId: 'h-4', error: { code: 'host.unavailable', message: expect.any(String) } },
    ]);
  });

  it('a releaseUploadTarget handler that resolves undefined answers result null', async () => {
    const { r, responses } = router();
    r.setServices(services({ releaseUploadTarget: async () => undefined }));
    r.handle({ hostCallId: 'h-1', method: 'releaseUploadTarget', args: {} });
    await flush();
    expect(responses).toEqual([{ hostCallId: 'h-1', result: null }]);
  });

  it('skips a queued request whose deadline passed, and ignores one without a hostCallId', async () => {
    const { r, responses } = router(10_000);
    const s = services();
    r.handle({ hostCallId: 'h-old', method: 'getUploadTarget', args: {}, deadline: 9_999 });
    r.handle({ method: 'getUploadTarget', args: {} });
    r.handle('nonsense');
    r.setServices(s);
    await flush();
    expect(s.getUploadTarget).not.toHaveBeenCalled();
    expect(responses).toEqual([]);
  });
});

describe('host requests through the client', () => {
  function adapter() {
    let listener: ((e: BridgeEvent) => void) | null = null;
    const calls: { method: string; args: Json }[] = [];
    const a: PulseAdapter = {
      kind: 'fake',
      present: async () => true,
      call: async (method, args, callId) => {
        calls.push({ method, args });
        if (method === 'info') {
          return buildReply({
            ok: true,
            callId,
            result: {
              contract: { major: 1, minor: 1 },
              methods: ['info', 'respondHostRequest'],
              supported: true,
            },
          });
        }
        return buildReply({ ok: true, callId, result: null });
      },
      subscribe: (cb) => {
        listener = cb;
        return () => {};
      },
      toWebUrl: (p) => p,
    };
    const emit = (payload: unknown) =>
      listener?.({ v: 1, name: 'hostRequest', payload: payload as Json });
    return { a, calls, emit };
  }

  it('answers a hostRequest event with respondHostRequest after setHostServices', async () => {
    const f = adapter();
    const client = createPulseClient({ adapter: f.a });
    f.emit({
      hostCallId: 'h-1',
      method: 'getUploadTarget',
      args: { draftId: 'd-1' },
      deadline: Date.now() + 20_000,
    });
    await flush();
    expect(f.calls).toEqual([]);
    client.setHostServices(services());
    await flush();
    await flush();
    expect(f.calls.map((c) => c.method)).toEqual(['info', 'respondHostRequest']);
    expect(f.calls[1].args).toEqual({ hostCallId: 'h-1', result: target });
  });

  it('never delivers hostRequest to on() listeners', async () => {
    const f = adapter();
    const client = createPulseClient({ adapter: f.a });
    const log = jest.fn();
    client.on('hostRequest' as 'log', log);
    f.emit({ hostCallId: 'h-1', method: 'getUploadTarget', args: {} });
    await flush();
    expect(log).not.toHaveBeenCalled();
  });
});
