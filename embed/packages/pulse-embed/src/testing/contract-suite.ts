import type {
  ConfirmSendRequest,
  FlowResult,
  HostServices,
  Json,
  PulseClient,
  PulseContext,
  PulseInfo,
} from '../types';
import type { FakeStep } from './fake';

/**
 * runPulseContract: the host contract as one test suite that any Pulse implementation must pass,
 * jest or vitest (nothing here imports a test framework). It runs against the fake today; PR2-K
 * runs it against the real command router (a Node adapter) and on a device against the plugin.
 *
 * Each test asks `make(setup)` for a fresh subject. `setup` says what the facade must do for that
 * test: which flow steps the person (or a script) takes, info overrides, and whether the next
 * result is lost to a reload. A maker that can't arrange it (a real device) shows it to the person
 * or leaves those tests out.
 */

export interface PulseContractSetup {
  /** What each open does, in order; the last one repeats. */
  flows: FakeStep[];
  /** Merged over the facade's info (method lists, fields a newer facade sends). */
  info?: Partial<PulseInfo> & { [key: string]: unknown };
  /** The next open's result goes only to the inbox (the page reloaded while Pulse was open). */
  dropNextResult?: boolean;
}

/** What a maker gives back: the client, and the controls the implementation has. */
export interface PulseContractSubject {
  client: PulseClient;
  /** Simulates a WebView reload: the old page's listeners are gone; returns the new page's client. */
  reload?(): PulseClient | Promise<PulseClient>;
  /** Called after each test. */
  dispose?(): void;
}

export type PulseContractMaker = (
  setup: PulseContractSetup,
) => Promise<PulseClient | PulseContractSubject> | PulseClient | PulseContractSubject;

/** The test framework's functions: jest's and vitest's both fit. */
export interface PulseContractTest {
  describe: (n: string, f: () => void) => void;
  it: (n: string, f: () => Promise<void> | void) => void;
  expect: unknown;
}

interface Matchers {
  toBe(v: unknown): void;
  toEqual(v: unknown): void;
}
type Expect = (v: unknown) => Matchers;

const CONTEXT: PulseContext = { key: 'ticket:42', kind: 'ticket', id: '42', label: 'Fix login' };

function ctx(over: Partial<PulseContext> = {}): PulseContext {
  return { ...CONTEXT, ...over };
}

function isSubject(v: unknown): v is PulseContractSubject {
  return typeof v === 'object' && v !== null && 'client' in v && typeof v.client === 'object';
}

/** Polls `check` with real timers until it holds, or fails after `timeoutMs`. */
async function waitFor(what: string, check: () => Promise<boolean> | boolean, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error(`runPulseContract: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The PulseError code a call rejected with, or 'resolved'. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : String(e);
  }
}

/** Whether `p` has settled, without waiting for it. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((r) => setTimeout(r, 20));
  return done;
}

const STATES_AFTER_SEND = [
  'preparing',
  'queued',
  'waiting_network',
  'uploading',
  'delivering',
  'needs_credentials',
  'sent',
];

export function runPulseContract(make: PulseContractMaker, t: PulseContractTest): void {
  const expect = t.expect as Expect;
  const { describe, it } = t;

  /** One test: a fresh subject, disposed afterwards. */
  function test(
    name: string,
    setup: PulseContractSetup,
    body: (s: PulseContractSubject) => Promise<void>,
  ) {
    it(name, async () => {
      const made = await make(setup);
      const s: PulseContractSubject = isSubject(made) ? made : { client: made };
      try {
        await body(s);
      } finally {
        s.dispose?.();
      }
    });
  }

  async function reload(s: PulseContractSubject): Promise<PulseClient> {
    if (!s.reload) throw new Error('runPulseContract: this maker gives no reload()');
    return s.reload();
  }

  describe('Pulse host contract', () => {
    test(
      'info speaks contract major 1 and lists its methods',
      { flows: [] },
      async ({ client }) => {
        const info = await client.getInfo();
        expect(info.contract.major).toBe(1);
        expect(info.supported).toBe(true);
        expect(info.methods.includes('open')).toBe(true);
        expect(await client.isAvailable()).toBe(true);
      },
    );

    describe('upload modes', () => {
      test(
        "'pulse' mode: Send resolves completed/pulse and queues the draft",
        { flows: [{ result: 'sent' }] },
        async ({ client }) => {
          await client.configure({ uploadMode: 'pulse' });
          const r = await client.record(ctx());
          expect(r.status).toBe('completed');
          if (r.status !== 'completed' || r.mode !== 'pulse') {
            throw new Error(`expected completed/pulse, got ${JSON.stringify(r)}`);
          }
          expect(typeof r.sentAt).toBe('number');
          expect(r.draftKey.endsWith(`:${r.draftId}`)).toBe(true);
          expect(r.clientKey.startsWith(`${r.draftKey}:`)).toBe(true);
          expect(r.context).toEqual(ctx());
          if ((await client.getInfo()).methods.includes('getDraft')) {
            const d = await client.getDraft(r.draftId);
            expect(STATES_AFTER_SEND.includes(d?.state ?? 'missing')).toBe(true);
            expect(d?.draftKey).toBe(r.draftKey);
          }
          await client.acknowledge(r.requestId);
        },
      );

      test(
        "'file' mode: Use this video resolves completed/file with a loadable export",
        { flows: [{ result: 'file' }] },
        async ({ client }) => {
          await client.configure({ uploadMode: 'file' });
          const r = await client.record(ctx());
          if (r.status !== 'completed' || r.mode !== 'file') {
            throw new Error(`expected completed/file, got ${JSON.stringify(r)}`);
          }
          expect(typeof r.durationMs).toBe('number');
          expect(r.export.rel.length > 0).toBe(true);
          expect(r.export.webUrl.length > 0).toBe(true);
          const pending = await client.pendingResults();
          expect(pending.map((p) => p.requestId).includes(r.requestId)).toBe(true);
          await client.acknowledge(r.requestId);
          const after = await client.pendingResults();
          expect(after.map((p) => p.requestId).includes(r.requestId)).toBe(false);
        },
      );
    });

    describe('unknown fields', () => {
      test(
        'unknown request fields are ignored, and the context comes back verbatim',
        { flows: [{ result: 'kept' }] },
        async ({ client }) => {
          await client.configure({ uploadMode: 'pulse', futureOption: true } as never);
          const context = { ...ctx(), futureContextField: { a: 1 } } as PulseContext;
          const r = await client.open({
            entry: 'record',
            context,
            futureRequestField: 'x',
          } as never);
          expect(r.status).toBe('closed');
          expect(r.context).toEqual(context);
        },
      );

      test(
        'unknown result fields pass through',
        {
          flows: [{ result: 'kept', extra: { futureResultField: 'r' } }],
          info: { futureInfoField: 'i' },
        },
        async ({ client }) => {
          const info = (await client.getInfo()) as PulseInfo & { futureInfoField?: Json };
          expect(info.futureInfoField).toBe('i');
          const r = (await client.record(ctx())) as FlowResult & { futureResultField?: Json };
          expect(r.futureResultField).toBe('r');
        },
      );
    });

    describe('the inbox', () => {
      test(
        'a result lost to a reload drains from the inbox once',
        { flows: [{ result: 'kept' }], dropNextResult: true },
        async (s) => {
          const lost = s.client.record(ctx(), { requestId: 'reload-1' });
          await waitFor('the result in the inbox', async () => {
            return (await s.client.pendingResults()).length > 0;
          });
          const client = await reload(s);
          const heard: FlowResult[] = [];
          client.on('flowResult', (r) => heard.push(r));
          const pending = await client.pendingResults();
          expect(pending.map((p) => p.requestId)).toEqual(['reload-1']);
          expect(pending[0].status).toBe('closed');
          await client.acknowledge('reload-1');
          expect(await client.pendingResults()).toEqual([]);
          expect(await settled(lost)).toBe(false);
          expect(heard).toEqual([]);
        },
      );

      test(
        'a flow that ends during a reload reaches the new page as a retained flowResult',
        { flows: [{ result: 'kept', afterMs: 150 }] },
        async (s) => {
          void s.client.record(ctx(), { requestId: 'reload-2' }).catch(() => {});
          await waitFor('the flow to open', () => s.client.isOpen());
          const client = await reload(s);
          const heard: FlowResult[] = [];
          await waitFor('the flow to end', async () => !(await client.isOpen()));
          // Attached only after the flow ended with nobody listening: the result was retained.
          client.on('flowResult', (r) => heard.push(r));
          await waitFor('the retained flowResult', () => heard.length > 0);
          expect(heard.map((r) => r.requestId)).toEqual(['reload-2']);
          await client.acknowledge('reload-2');
        },
      );
    });

    describe('open', () => {
      test(
        'open with the same requestId while open resolves the same result, also after a reload',
        { flows: [{ result: 'kept', afterMs: 100 }] },
        async (s) => {
          const a = s.client.record(ctx(), { requestId: 'same-1' });
          const b = s.client.record(ctx(), { requestId: 'same-1' });
          await waitFor('the flow to open', () => s.client.isOpen());
          const c = s.reload ? (await reload(s)).record(ctx(), { requestId: 'same-1' }) : a;
          const [ra, rb, rc] = await Promise.all([a, b, c]);
          expect(rb).toEqual(ra);
          expect(rc).toEqual(ra);
          expect(ra.status).toBe('closed');
        },
      );

      test(
        'another open while a flow is open is busy',
        { flows: [{ result: 'kept', afterMs: 100 }] },
        async ({ client }) => {
          const first = client.record(ctx(), { requestId: 'busy-1' });
          await waitFor('the flow to open', () => client.isOpen());
          expect(await codeOf(client.record(ctx(), { requestId: 'busy-2' }))).toBe('busy');
          expect((await first).requestId).toBe('busy-1');
        },
      );

      test('record without a context is rejected', { flows: [] }, async ({ client }) => {
        expect(await codeOf(client.open({ entry: 'record' } as never))).toBe('invalid_options');
        expect(await codeOf(client.record({ label: 'No key' } as never))).toBe('invalid_options');
        expect(await client.isOpen()).toBe(false);
      });
    });

    test(
      'a method the facade does not list rejects method.unsupported',
      {
        flows: [{ result: 'kept' }],
        info: {
          methods: [
            'info',
            'configure',
            'prewarm',
            'open',
            'close',
            'isOpen',
            'pendingResults',
            'acknowledge',
            'logFile',
          ],
        },
      },
      async ({ client }) => {
        expect(await codeOf(client.listDrafts())).toBe('method.unsupported');
        expect(await codeOf(client.upload('d-1'))).toBe('method.unsupported');
        expect(await codeOf(client.setAccount(null))).toBe('method.unsupported');
        const r = await client.record(ctx());
        expect(r.status).toBe('closed');
      },
    );

    describe('confirmSend', () => {
      const clock = ctx({
        key: 'clock:e1',
        kind: 'clock',
        id: 'e1',
        label: 'Mon 9:02 session',
        uploadType: { id: 'clock.wrapup', version: 1, confirmSend: true, requireOnline: true },
      });

      test(
        'Send asks confirmSend before the flow closes, and the result carries confirmedAt',
        { flows: [{ result: 'sent' }] },
        async ({ client }) => {
          await client.configure({ uploadMode: 'pulse' });
          const asked: ConfirmSendRequest[] = [];
          const openWhileAsked: boolean[] = [];
          const heard: FlowResult[] = [];
          client.on('flowResult', (r) => heard.push(r));
          const services: HostServices = {
            getUploadTarget: () => new Promise(() => {}),
            refreshUploadToken: () => new Promise(() => {}),
            confirmSend: async (r) => {
              asked.push(r);
              openWhileAsked.push(await client.isOpen());
              openWhileAsked.push(heard.length === 0);
              return { confirmedAt: 1_763_400_000_000 };
            },
          };
          client.setHostServices(services);
          const r = await client.record(clock);
          if (r.status !== 'completed' || r.mode !== 'pulse') {
            throw new Error(`expected completed/pulse, got ${JSON.stringify(r)}`);
          }
          expect(asked.length).toBe(1);
          expect(openWhileAsked).toEqual([true, true]);
          expect(asked[0].draftKey).toBe(r.draftKey);
          expect(asked[0].sentAt).toBe(r.sentAt);
          expect(asked[0].uploadType.id).toBe('clock.wrapup');
          expect(r.confirmedAt).toBe(1_763_400_000_000);
        },
      );

      test(
        'a confirmSend failure keeps Pulse open and the draft unsent',
        { flows: [{ result: 'sent' }] },
        async ({ client }) => {
          await client.configure({ uploadMode: 'pulse' });
          let asked = 0;
          client.setHostServices({
            getUploadTarget: () => new Promise(() => {}),
            refreshUploadToken: () => new Promise(() => {}),
            confirmSend: () => {
              asked += 1;
              return Promise.reject({ code: 'host.unavailable', message: 'Clock server down' });
            },
          });
          const flow = client.record(clock, { requestId: 'confirm-fail' });
          await waitFor('confirmSend', () => asked > 0);
          await new Promise((r) => setTimeout(r, 30));
          expect(await client.isOpen()).toBe(true);
          expect(await settled(flow)).toBe(false);
          const pending = await client.pendingResults();
          expect(pending.map((p) => p.requestId).includes('confirm-fail')).toBe(false);
          await client.close();
          const r = await flow;
          expect(r.status).toBe('closed');
          if (r.status !== 'closed') return;
          expect(r.reason).toBe('host');
          if ((await client.getInfo()).methods.includes('getDraft')) {
            const d = await client.getDraft(r.draftId);
            expect(d === null).toBe(false);
            expect(['draft', 'ready'].includes(d?.state ?? 'missing')).toBe(true);
            expect(d?.upload === undefined && d?.confirmedAt === undefined).toBe(true);
          }
          await client.acknowledge('confirm-fail');
        },
      );
    });
  });
}
