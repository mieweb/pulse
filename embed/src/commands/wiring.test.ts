import { describe, expect, it, jest } from '@jest/globals';

import type { HostRequestPayload } from '@/features/upload/core/host-services';

import { createChannel, createNetworkFeed, type Message } from '../shell/messaging';
import { connectHostRequests } from './host-requests';
import { brownfieldUploadTransport } from './upload-transport';

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
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const REQUEST: HostRequestPayload = {
  hostCallId: 'h-1',
  method: 'refreshUploadToken',
  args: { uploadId: 'u1', clientKey: 'ck', draftId: 'd1' },
  deadline: 20_000,
};

describe('host requests over the channel (native-bridge.md §5)', () => {
  function connected() {
    const t = fakeTransport();
    const port = {
      sink: null as ((p: HostRequestPayload) => void) | null,
      responses: [] as unknown[],
      timedOut: [] as string[],
      setHostRequestSink(sink: ((p: HostRequestPayload) => void) | null) {
        port.sink = sink;
      },
      respondToHostRequest: (m: unknown) => void port.responses.push(m),
      hostRequestTimedOut: (id: string) => void port.timedOut.push(id),
    };
    const disconnect = connectHostRequests(createChannel(t.transport), port);
    return { t, port, disconnect };
  }

  it('a request leaves as a hostRequest event', () => {
    const { t, port } = connected();
    port.sink?.(REQUEST);
    expect(t.sent).toEqual([{ type: 'pulse.event', name: 'hostRequest', payload: REQUEST }]);
  });

  it('pulse.respond is the host’s answer; pulse.cmd hostTimeout is the facade’s deadline', async () => {
    const { t, port } = connected();
    const answer = {
      type: 'pulse.respond',
      hostCallId: 'h-1',
      result: { token: 't', expiresAt: 1 },
    };
    await t.native(answer);
    await t.native({
      type: 'pulse.cmd',
      callId: 'n-1',
      method: 'hostTimeout',
      args: { hostCallId: 'h-2' },
    });
    expect(port.responses).toEqual([answer]);
    expect(port.timedOut).toEqual(['h-2']);
    expect(t.sent).toEqual([{ type: 'pulse.reply', callId: 'n-1', ok: true, result: null }]);
  });

  it('disconnecting clears the sink (failing what waits) and stops listening', async () => {
    const { t, port, disconnect } = connected();
    disconnect();
    expect(port.sink).toBeNull();
    await t.native({ type: 'pulse.respond', hostCallId: 'h-1', result: null });
    expect(port.responses).toEqual([]);
  });
});

describe('the background upload transport (O16)', () => {
  it('sends pulse.upload ops and hears only the uploader’s answers', () => {
    const sent: Record<string, unknown>[] = [];
    let listener: ((m: Record<string, unknown>) => void) | null = null;
    const remove = jest.fn();
    const transport = brownfieldUploadTransport({
      sendMessage: (m) => void sent.push(m),
      addMessageListener: (l) => {
        listener = l;
        return { remove };
      },
    });
    const heard: unknown[] = [];
    const stop = transport.listen((m) => void heard.push(m));
    transport.send({ type: 'pulse.upload', op: 'hello', id: 'bg-1' });
    listener!({ type: 'pulse.upload.end', id: 'bg-1', ok: true });
    listener!({ type: 'pulse.upload.progress', id: 'bg-2', sent: 10 });
    listener!({ type: 'pulse.cmd', callId: 'n-1', method: 'network' });
    listener!({ type: 'pulse.respond', hostCallId: 'h-1' });
    stop();
    expect(sent).toEqual([{ type: 'pulse.upload', op: 'hello', id: 'bg-1' }]);
    expect(heard).toEqual([
      { type: 'pulse.upload.end', id: 'bg-1', ok: true },
      { type: 'pulse.upload.progress', id: 'bg-2', sent: 10 },
    ]);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('the network feed (pulse.cmd network)', () => {
  it('starts from the initial props and tells subscribers only of real changes', () => {
    const feed = createNetworkFeed({ online: false, wifi: false, expensive: true });
    expect([feed.source.isOnline(), feed.source.isWifi()]).toEqual([false, false]);
    const changes = jest.fn();
    feed.source.subscribe(changes);
    feed.update({ online: false, wifi: false, expensive: true });
    feed.update({ online: true, wifi: true, expensive: false });
    feed.update('not a state');
    expect(changes).toHaveBeenCalledTimes(1);
    expect([feed.source.isOnline(), feed.source.isWifi()]).toEqual([true, true]);
  });

  it('without initial props it says what the default does: online, Wi-Fi unknown', () => {
    const feed = createNetworkFeed(undefined);
    expect([feed.source.isOnline(), feed.source.isWifi()]).toEqual([true, null]);
  });
});
