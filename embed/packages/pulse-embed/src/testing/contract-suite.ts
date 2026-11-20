import type {
  ConfirmSendRequest,
  DraftSummary,
  FlowResult,
  HostServices,
  Json,
  PulseAccount,
  PulseClient,
  PulseContext,
  PulseInfo,
  UploadTarget,
} from '../types';
import { createFakePulse, type FakeScript, type FakeStep } from './fake';
import type { FetchLike } from './tus';

/**
 * runPulseContract: the host contract as one test suite that any Pulse implementation must pass,
 * jest or vitest (nothing here imports a test framework). It runs against the fake
 * (contract.test.ts), against the real Pulse JS code through a Node facade
 * (embed/src/test-support/contract-parity.test.ts), and on a phone against the plugin (the cap-host
 * contract page).
 *
 * Each test asks `make(setup)` for a fresh subject. `setup` says what the facade must do for that
 * test: which flow steps the person (or a script) takes, info overrides, whether the next result is
 * lost to a reload, and whether uploads run. A maker that can't arrange something says so in
 * `options.can`, and the tests that need it are left out (a phone's person follows the flow steps;
 * nobody can script its info, a reload or its network).
 *
 * The data tests sign in as CONTRACT_ACCOUNT first, so they run in a namespace of their own.
 */

/** The account the data tests sign in as. */
export const CONTRACT_ACCOUNT: PulseAccount = Object.freeze({
  serverOrigin: 'https://contract.example',
  userId: 'contract-user',
});

export interface PulseContractSetup {
  /** What each open does, in order; the last one repeats. */
  flows: FakeStep[];
  /** Merged over the facade's info (method lists, fields a newer facade sends). */
  info?: Partial<PulseInfo> & { [key: string]: unknown };
  /** The next open's result goes only to the inbox (the page reloaded while Pulse was open). */
  dropNextResult?: boolean;
  /**
   * Uploads run: a queued job asks the host's getUploadTarget, and the upload server never answers
   * (every request to it hangs), so the job stays in the state the host's answer put it in.
   */
  server?: boolean;
}

/** What a maker gives back: the client, and the controls the implementation has. */
export interface PulseContractSubject {
  client: PulseClient;
  /** Simulates a WebView reload: the old page's listeners are gone; returns the new page's client. */
  reload?(): PulseClient | Promise<PulseClient>;
  /** The device's network: offline, a queued job reads `waiting_network`. */
  setOnline?(online: boolean): void | Promise<void>;
  /** Called after each test. */
  dispose?(): void | Promise<void>;
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

/** What a maker can arrange. Each defaults to true; a test needing one that's false is left out. */
export interface PulseContractAbilities {
  /** `setup.info`: the facade's info, overridden. */
  info?: boolean;
  /** `subject.reload()` and `setup.dropNextResult`. */
  reload?: boolean;
  /** `subject.setOnline()`. */
  network?: boolean;
  /** `setup.server`: uploads that run against a server that never answers. */
  server?: boolean;
}

export interface PulseContractOptions {
  can?: PulseContractAbilities;
  /** How long a wait for a state lasts before the test fails. Default 3000 ms. */
  waitMs?: number;
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

let waitMs = 3000;

/** Polls `check` with real timers until it holds, or fails after `timeoutMs`. */
async function waitFor(what: string, check: () => Promise<boolean> | boolean, timeoutMs = waitMs) {
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

/** The ids of listed drafts. */
function ids(list: DraftSummary[]): string[] {
  return list.map((d) => d.id);
}

/** The rejection's fields (code, reason, draftId), or a failure when it resolved. */
async function rejection(p: Promise<unknown>): Promise<{ code?: string; reason?: string }> {
  try {
    await p;
  } catch (e) {
    return (typeof e === 'object' && e !== null ? e : { code: String(e) }) as {
      code?: string;
      reason?: string;
    };
  }
  throw new Error('runPulseContract: expected a rejection');
}

/** Host services whose every request hangs, unless `over` answers it. */
function services(over: Partial<HostServices> = {}): HostServices {
  return {
    getUploadTarget: () => new Promise(() => {}),
    refreshUploadToken: () => new Promise(() => {}),
    ...over,
  };
}

/** A target on a server that never answers (the maker's `server`). */
function target(clientKey: string): UploadTarget {
  return {
    uploadId: 'contract-upload-1',
    endpoint: 'https://vault.contract.example/pulsevault',
    artifactId: '11111111-2222-4333-8444-555555555555',
    token: 'contract-token',
    expiresAt: Date.now() + 3_600_000,
    clientKey,
  };
}

/** Sign in as CONTRACT_ACCOUNT, in `uploadMode`. */
async function signIn(client: PulseClient, uploadMode: 'pulse' | 'file'): Promise<void> {
  await client.configure({ uploadMode });
  await client.setAccount(CONTRACT_ACCOUNT);
}

type Sent = Extract<FlowResult, { status: 'completed'; mode: 'pulse' }>;

/** Record and Send for `context`: the completed/pulse result. */
async function sent(client: PulseClient, context: PulseContext = ctx()): Promise<Sent> {
  const r = await client.record(context);
  if (r.status !== 'completed' || r.mode !== 'pulse') {
    throw new Error(`expected completed/pulse, got ${JSON.stringify(r)}`);
  }
  return r;
}

export function runPulseContract(
  make: PulseContractMaker,
  t: PulseContractTest,
  options: PulseContractOptions = {},
): void {
  const expect = t.expect as Expect;
  const { describe, it } = t;
  const can: Required<PulseContractAbilities> = {
    info: true,
    reload: true,
    network: true,
    server: true,
    ...options.can,
  };
  if (options.waitMs !== undefined) waitMs = options.waitMs;

  /** One test: a fresh subject, disposed afterwards. Left out when it needs what the maker can't. */
  function test(
    name: string,
    setup: PulseContractSetup,
    body: (s: PulseContractSubject) => Promise<void>,
    needs: (keyof PulseContractAbilities)[] = [],
  ) {
    const wanted = [...needs];
    if (setup.info) wanted.push('info');
    if (setup.dropNextResult) wanted.push('reload');
    if (setup.server) wanted.push('server');
    if (wanted.some((n) => !can[n])) return;
    it(name, async () => {
      const made = await make(setup);
      const s: PulseContractSubject = isSubject(made) ? made : { client: made };
      try {
        await body(s);
      } finally {
        await s.dispose?.();
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
        // Minor 1: the data API (setAccount, the drafts, the outbox, host requests).
        expect(info.contract.minor).toBe(1);
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
        ['reload'],
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

    describe('the data API (contract minor 1)', () => {
      const clock = ctx({
        key: 'clock:e2',
        kind: 'clock',
        id: 'e2',
        label: 'Tue 9:00 session',
        uploadType: { id: 'clock.wrapup', version: 1, confirmSend: true },
      });

      test(
        'signed out, data calls and open reject no_account; signing in answers again',
        { flows: [{ result: 'kept' }] },
        async ({ client }) => {
          expect((await client.setAccount(null)).namespace).toBe(null);
          expect((await client.getInfo()).namespace).toBe(null);
          expect(await codeOf(client.listDrafts())).toBe('no_account');
          expect(await codeOf(client.getDraft('d-1'))).toBe('no_account');
          expect(await codeOf(client.renameDraft('d-1', 'x'))).toBe('no_account');
          expect(await codeOf(client.record(ctx()))).toBe('no_account');
          const { namespace } = await client.setAccount(CONTRACT_ACCOUNT);
          expect(typeof namespace).toBe('string');
          expect((await client.getInfo()).namespace).toBe(namespace);
          expect(Array.isArray(await client.listDrafts())).toBe(true);
        },
      );

      test(
        "writes on a draft Pulse doesn't have are not_found, and getDraft is null",
        { flows: [] },
        async ({ client }) => {
          await signIn(client, 'pulse');
          const id = 'no-such-draft';
          expect(await client.getDraft(id)).toBe(null);
          expect(await codeOf(client.renameDraft(id, 'x'))).toBe('not_found');
          expect(await codeOf(client.deleteDraft(id))).toBe('not_found');
          expect(await codeOf(client.setDraftContext(id, ctx()))).toBe('not_found');
          expect(await codeOf(client.upload(id))).toBe('not_found');
          expect(await codeOf(client.cancelUpload(id))).toBe('not_found');
          expect(await codeOf(client.retireDraft(id))).toBe('not_found');
          expect(await codeOf(client.dismissReceipt(id))).toBe('not_found');
        },
      );

      test(
        'the draft an open flow holds is locked against host writes until the flow ends',
        { flows: [{ result: 'kept' }, { result: 'kept', afterMs: 300 }] },
        async ({ client }) => {
          await signIn(client, 'pulse');
          const first = await client.record(ctx());
          if (first.status !== 'closed') throw new Error(`expected closed, got ${first.status}`);
          const editing = client.edit(first.draftId, { requestId: 'held-1' });
          await waitFor('the flow to open', () => client.isOpen());
          expect(await codeOf(client.renameDraft(first.draftId, 'Renamed'))).toBe('draft.locked');
          expect(await codeOf(client.deleteDraft(first.draftId))).toBe('draft.locked');
          expect(await codeOf(client.upload(first.draftId))).toBe('draft.locked');
          expect((await editing).status).toBe('closed');
          await client.renameDraft(first.draftId, 'Renamed');
          expect((await client.getDraft(first.draftId))?.name).toBe('Renamed');
          await client.acknowledge('held-1');
          await client.acknowledge(first.requestId);
        },
      );

      test(
        "'file' mode: retireDraft turns the draft into a receipt; dismissReceipt marks it seen",
        { flows: [{ result: 'file' }] },
        async ({ client }) => {
          await signIn(client, 'file');
          const r = await client.record(ctx());
          if (r.status !== 'completed' || r.mode !== 'file') {
            throw new Error(`expected completed/file, got ${JSON.stringify(r)}`);
          }
          expect((await client.getDraft(r.draftId))?.state).toBe('ready');
          await client.retireDraft(r.draftId);
          const sent = await client.getDraft(r.draftId);
          expect(sent?.state).toBe('sent');
          expect(sent?.sent?.outcome).toBe('done');
          expect(sent?.sent?.dismissed).toBe(false);
          expect(ids(await client.listDrafts()).includes(r.draftId)).toBe(false);
          expect(ids(await client.listDrafts({ states: ['sent'] })).includes(r.draftId)).toBe(true);
          // Retired already: a no-op. A receipt is no draft to the other writes.
          await client.retireDraft(r.draftId);
          expect(await codeOf(client.renameDraft(r.draftId, 'x'))).toBe('not_found');
          expect(await codeOf(client.deleteDraft(r.draftId))).toBe('not_found');
          await client.dismissReceipt(r.draftId);
          expect((await client.getDraft(r.draftId))?.sent?.dismissed).toBe(true);
          await client.acknowledge(r.requestId);
        },
      );

      test(
        "'pulse' mode: retireDraft is only a hint, and dismissReceipt needs a receipt",
        { flows: [{ result: 'sent' }] },
        async ({ client }) => {
          await signIn(client, 'pulse');
          const r = await sent(client);
          await client.retireDraft(r.draftId);
          const d = await client.getDraft(r.draftId);
          expect(d?.state === 'sent').toBe(false);
          expect(await codeOf(client.dismissReceipt(r.draftId))).toBe('not_found');
          expect(await codeOf(client.upload(r.draftId))).toBe('resolved');
          expect((await client.upload(r.draftId)).clientKey).toBe(r.clientKey);
          await client.acknowledge(r.requestId);
        },
      );

      test(
        'a Send made offline reads waiting_network, from the network rather than the catalog',
        { flows: [{ result: 'sent' }] },
        async (s) => {
          const { client } = s;
          await signIn(client, 'pulse');
          await s.setOnline?.(false);
          const r = await sent(client);
          expect((await client.getDraft(r.draftId))?.state).toBe('waiting_network');
          const waiting = await client.listDrafts({ states: ['waiting_network'] });
          expect(ids(waiting).includes(r.draftId)).toBe(true);
          expect(ids(await client.listDrafts({ states: ['queued'] })).includes(r.draftId)).toBe(
            false,
          );
          await s.setOnline?.(true);
          await waitFor('queued once online', async () => {
            return (await client.getDraft(r.draftId))?.state === 'queued';
          });
          await client.acknowledge(r.requestId);
        },
        ['network'],
      );

      test(
        'a Send the host answers no_account waits in needs_credentials until resumeOutbox',
        { flows: [{ result: 'sent' }], server: true },
        async ({ client }) => {
          await signIn(client, 'pulse');
          let refuse = true;
          client.setHostServices(
            services({
              getUploadTarget: () =>
                refuse
                  ? Promise.reject({ code: 'no_account', message: 'Signed out' })
                  : new Promise(() => {}),
            }),
          );
          const r = await sent(client);
          await waitFor('needs_credentials', async () => {
            return (await client.getDraft(r.draftId))?.state === 'needs_credentials';
          });
          const paused = await client.getDraft(r.draftId);
          expect(paused?.upload?.error?.code).toBe('no_account');
          expect(paused?.upload?.error?.recoverable).toBe(true);
          expect(paused?.upload?.clientKey).toBe(r.clientKey);
          refuse = false;
          await client.resumeOutbox();
          await waitFor('queued again', async () => {
            return (await client.getDraft(r.draftId))?.state === 'queued';
          });
          await client.acknowledge(r.requestId);
        },
      );

      test(
        'while uploading: edits, Move to…, Delete and Send are locked; Cancel sending is not',
        { flows: [{ result: 'sent' }], server: true },
        async ({ client }) => {
          await signIn(client, 'pulse');
          client.setHostServices(services({ getUploadTarget: async (q) => target(q.clientKey) }));
          const r = await sent(client);
          await waitFor('uploading', async () => {
            return (await client.getDraft(r.draftId))?.state === 'uploading';
          });
          const before = await client.getDraft(r.draftId);
          expect(await codeOf(client.renameDraft(r.draftId, 'Renamed'))).toBe('draft.locked');
          expect(await codeOf(client.deleteDraft(r.draftId))).toBe('draft.locked');
          expect(await codeOf(client.setDraftContext(r.draftId, ctx({ label: 'Elsewhere' })))).toBe(
            'draft.locked',
          );
          expect(await codeOf(client.upload(r.draftId))).toBe('draft.locked');
          await client.retireDraft(r.draftId);
          const still = await client.getDraft(r.draftId);
          expect(still?.state).toBe('uploading');
          expect(still?.name).toBe(before?.name);
          await client.cancelUpload(r.draftId);
          const canceled = await client.getDraft(r.draftId);
          expect(canceled?.state).toBe('ready');
          expect(canceled?.upload === undefined).toBe(true);
          await client.renameDraft(r.draftId, 'Renamed');
          expect((await client.getDraft(r.draftId))?.name).toBe('Renamed');
          await client.acknowledge(r.requestId);
        },
      );

      test(
        'while delivering: Cancel sending and edits are locked; retireDraft waits for the server',
        { flows: [{ result: 'sent' }], server: true },
        async ({ client }) => {
          await signIn(client, 'pulse');
          client.setHostServices(
            services({
              getUploadTarget: async (q) => ({ ...target(q.clientKey), state: 'delivered' }),
            }),
          );
          const r = await sent(client);
          await waitFor('delivering', async () => {
            return (await client.getDraft(r.draftId))?.state === 'delivering';
          });
          expect(await codeOf(client.cancelUpload(r.draftId))).toBe('draft.locked');
          expect(await codeOf(client.renameDraft(r.draftId, 'x'))).toBe('draft.locked');
          expect(await codeOf(client.deleteDraft(r.draftId))).toBe('draft.locked');
          await client.retireDraft(r.draftId);
          expect((await client.getDraft(r.draftId))?.state).toBe('delivering');
          await client.acknowledge(r.requestId);
        },
      );

      test(
        'a clock-bound draft refuses Move to… (clock_bound), and a new Send keeps its first sentAt',
        { flows: [{ result: 'sent' }] },
        async ({ client }) => {
          await signIn(client, 'pulse');
          let asked = 0;
          client.setHostServices(
            services({
              confirmSend: async () => {
                asked += 1;
                return { confirmedAt: 1_763_500_000_000 };
              },
            }),
          );
          const r = await sent(client, clock);
          expect(r.confirmedAt).toBe(1_763_500_000_000);
          const moved = await rejection(client.setDraftContext(r.draftId, ctx()));
          expect(moved.code).toBe('draft.locked');
          expect(moved.reason).toBe('clock_bound');
          // A rename takes the queued Send back; the draft stays bound to its clock action.
          await client.renameDraft(r.draftId, 'Wrap-up');
          const renamed = await client.getDraft(r.draftId);
          expect(renamed?.state).toBe('ready');
          expect(renamed?.confirmedAt).toBe(1_763_500_000_000);
          const again = await client.upload(r.draftId);
          expect(again.sentAt).toBe(r.sentAt);
          expect(again.draftKey).toBe(r.draftKey);
          // The same cut: the same clientKey.
          expect(again.clientKey).toBe(r.clientKey);
          expect(asked).toBe(1);
          // Deleting it still works: the host cancels its clock intent (O13).
          await client.deleteDraft(r.draftId);
          expect(await client.getDraft(r.draftId)).toBe(null);
          await client.acknowledge(r.requestId);
        },
      );
    });
  });
}

/** A fetch that never answers (the `server` that never answers); an abort rejects it. */
const neverAnswers: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
    );
  });

/**
 * The maker for the fake: `runPulseContract(fakeContractMaker(), t)`. `script` adds to every
 * test's fake (latency, say).
 */
export function fakeContractMaker(script: FakeScript = {}): PulseContractMaker {
  return (setup) => {
    const fake = createFakePulse({
      ...script,
      flows: setup.flows,
      ...(setup.info ? { info: setup.info } : {}),
      ...(setup.dropNextResult ? { dropNextResult: true } : {}),
      ...(setup.server ? { server: { fixture: new ArrayBuffer(16), fetch: neverAnswers } } : {}),
    });
    return {
      client: fake.client,
      reload: () => fake.reload(),
      setOnline: (online) => fake.setOnline(online),
      dispose: () => fake.dispose(),
    };
  };
}
