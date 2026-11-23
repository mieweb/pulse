import { createHash } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import type {
  BridgeEvent,
  BridgeReply,
  FlowResult,
  Json,
  OpenRequest,
  PulseAccount,
  PulseAdapter,
  PulseClient,
  PulseInfo,
} from '@mieweb/pulse-embed';
import type { FakeStep } from '@mieweb/pulse-embed/testing';

import { isOnline } from '@/core/network';
import { db } from '@/db/client';
import { addSegment, createDraft, segmentsForDraft } from '@/db/drafts';
import { drafts } from '@/db/schema';
import { exportAudio } from '@/features/export/editor-merge';
import { resolveMergedExport } from '@/features/export/merged-export';
import { uploadRulesOf } from '@/features/export/send-checks';
import { runSend } from '@/features/export/send-flow';
import type { CatalogDraft, CatalogFile } from '@/features/drafts/catalog';
import {
  countDrafts,
  listDrafts,
  readCatalogFile,
  shownState,
  type CountOptions,
  type DraftFilter,
  type NetworkView,
} from '@/features/drafts/catalog-filter';
import { startCatalogWriter } from '@/features/drafts/catalog-writer';
import { getRecorderFormat } from '@/features/recorder/recorder-format';
import { sendDraft } from '@/features/upload/core/outbox';
import { writeOriginalBytes } from '@/utils/file-store';
import { cacheDir } from '@/utils/storage-root';

import { createPulseClient } from '../../packages/pulse-embed/src/client';
import { buildReply, MINOR0_METHODS, routeRequest } from '../../packages/pulse-embed/src/envelope';
import { checkConfigure, checkOpen, isPlainName } from '../../packages/pulse-embed/src/validate';
import { holdFlowDraft } from '../commands/held-draft';
import { startRuntimeServices } from '../commands/runtime';
import { flowResult } from '../flow/result';
import type { FlowState } from '../flow/reducer';
import { embedChannel } from '../shell/channel';
import { createFlowController } from '../shell/flow-controller';
import { createFlowStore } from '../shell/flow-store';
import { removeDraft } from '../shell/library';
import { writeFlowResult } from '../shell/results';

/**
 * A PulseAdapter over the real PR2 code, for runPulseContract in Node (contract-parity.test.ts).
 *
 * Pulse JS is the real thing: the embedded runtime (commands/runtime.ts) with its command router,
 * library deps, outbox, job loop, host-request channel and catalog writer, over the real
 * migrations on node:sqlite (src/test-support/expo-sqlite-node.ts) and files on disk
 * (expo-fs-node). Two roles are played here instead:
 *
 * - **PulseKit (native).** What the Swift facade answers itself is scripted after PulseKit.swift:
 *   envelopes routed by the shared rules (envelope.ts `routeRequest`), `info`, `configure`,
 *   accounts and namespaces, the one-flow gate, the results inbox (`results/*.json`), catalog
 *   reads (catalog.json through the reader's rule, catalog-filter.ts, the TypeScript twin of
 *   PulseKitCatalog.swift), and host writes forwarded as `pulse.cmd` over the BrownfieldMessaging
 *   stand-in. Its background uploader answers `hello`, `sweep` and `attach` (nothing runs), and a
 *   PATCH never ends.
 * - **The person.** Each `open` plays its step (FakeStep, the fake's script) on the real flow
 *   store, reducer and controller (embed/src/shell, embed/src/flow): a take is a real draft and
 *   clip, Export's merge persists a real export, Send runs send-flow.ts over the real outbox
 *   (the host's confirm included), and the result goes through the real results inbox.
 *
 * Not modelled: catalog.json's debounce (reads see the library as of the read: the writer is
 * flushed first), the forward and host-request deadlines (the runtime's own 20 s host timer runs),
 * restarting a runtime after a purge, and the network beyond what `fetch` the test installs.
 */

/** The BrownfieldMessaging stand-in, seen from the native side. */
export interface NativeBus {
  /** Native → Pulse JS. */
  deliver(message: Record<string, unknown>): void;
  /** Pulse JS → native; returns the stop. */
  listen(onMessage: (message: Record<string, unknown>) => void): () => void;
}

export interface NodePulseOptions {
  /** What each open does, in order; the last one repeats. */
  flows: FakeStep[];
  /** Merged over the facade's info. */
  info?: Partial<PulseInfo> & { [key: string]: unknown };
  /** The next open's result goes only to the inbox. */
  dropNextResult?: boolean;
  /** The account signed in at start; its namespace is the runtime's. */
  account: PulseAccount;
  /** configure's hostId the namespace is keyed by. */
  hostId: string;
  /** The namespace's documents root (setStorageRoots was called with it before this loaded). */
  documents: string;
  bus: NativeBus;
}

export interface NodePulse {
  adapter: PulseAdapter;
  /** The current page's client; `reload()` replaces it. */
  readonly client: PulseClient;
  reload(): PulseClient;
  /** The device's network, as NWPathMonitor would report it (`pulse.cmd network`). */
  setOnline(online: boolean): Promise<void>;
  /** Releases Pulse's library (`releaseLibrary`) and stops every timer. */
  dispose(): Promise<void>;
}

/** The contract minor the facade answers (PulseKit.swift `contractMinor`). */
const FACADE_MINOR = 1;
const MINOR1_METHODS = [
  'setAccount',
  'listDrafts',
  'getDraft',
  'countDrafts',
  'renameDraft',
  'deleteDraft',
  'setDraftContext',
  'upload',
  'cancelUpload',
  'retireDraft',
  'dismissReceipt',
  'resumeOutbox',
  'usage',
  'listNamespaces',
  'purge',
  'respondHostRequest',
];
/** The host writes PulseKit forwards to Pulse JS (PulseKit.swift `forwardedMethods`). */
const FORWARDED = new Set([
  'renameDraft',
  'deleteDraft',
  'setDraftContext',
  'upload',
  'cancelUpload',
  'retireDraft',
  'dismissReceipt',
  'resumeOutbox',
]);
const UPLOADING_STATES = new Set([
  'preparing',
  'queued',
  'waiting_network',
  'uploading',
  'delivering',
]);
const CLIP_BYTES = 2048;
const DEFAULT_CLIP_MS = 5_000;

/** A failure the facade answers with (`ok: false`). */
class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** `<hostId>-` + 16 hex of SHA-256(origin + "\n" + userId) (PulseKitAccounts.swift). */
export function namespaceOf(hostId: string, account: PulseAccount): string {
  let origin = account.serverOrigin.toLowerCase();
  try {
    origin = new URL(account.serverOrigin).origin.toLowerCase();
  } catch {
    // Kept as given: the client already checked it.
  }
  const hash = createHash('sha256').update(`${origin}\n${account.userId}`, 'utf8').digest('hex');
  return `${hostId}-${hash.slice(0, 16)}`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** A cancellable wait: resolves true after `ms`, false when cancelled. */
function pause(ms: number, timers: Set<() => void>): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(cancel);
      resolve(true);
    }, ms);
    const cancel = () => {
      clearTimeout(timer);
      timers.delete(cancel);
      resolve(false);
    };
    timers.add(cancel);
  });
}

/** The size of everything under `dir`, in bytes (PulseKitStorage.bytes). */
function folderBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    n += entry.isDirectory() ? folderBytes(path) : statSync(path).size;
  }
  return n;
}

interface Flow {
  requestId: string;
  request: OpenRequest;
  step: FakeStep;
  drop: boolean;
  done: Promise<FlowResult>;
  resolve: (r: FlowResult) => void;
  ended: boolean;
  /** Undoes what the flow registered (its hold on the draft, its close handler). */
  cleanup: () => void;
}

export async function createNodePulse(o: NodePulseOptions): Promise<NodePulse> {
  const runtimeNamespace = namespaceOf(o.hostId, o.account);
  const steps = o.flows.length > 0 ? o.flows : [{ result: 'sent' } as FakeStep];
  let stepIndex = 0;
  let dropNext = o.dropNextResult === true;
  let config: Record<string, Json> = { uploadMode: 'pulse', hostId: o.hostId };
  let active: string | null = runtimeNamespace;
  let network = { online: true, wifi: true, expensive: false };
  let flow: Flow | null = null;
  let jsReady = false;
  let disposed = false;
  const cancels = new Set<() => void>();
  let callSeq = 0;
  const commands = new Map<string, (message: Record<string, unknown>) => void>();
  const waitingForReady: (() => void)[] = [];
  /** PATCHes that never end, by message id (cancelled ones end `canceled`). */
  const patches = new Set<string>();

  // ── Events to the host: one fan-out; flowResult and hostRequest wait for a subscriber (§7).
  const subscribers = new Set<(e: BridgeEvent) => void>();
  const retained: BridgeEvent[] = [];
  function emit(name: string, payload: unknown): void {
    const e: BridgeEvent = { v: 1, name, payload: clone(payload) as Json };
    if (subscribers.size === 0) {
      if (name === 'flowResult' || name === 'hostRequest') retained.push(e);
      return;
    }
    for (const cb of [...subscribers]) cb(e);
  }

  // ── Pulse JS → native.
  const stopListening = o.bus.listen((message) => {
    switch (message.type) {
      case 'pulse.ready':
        jsReady = true;
        for (const go of waitingForReady.splice(0)) go();
        return;
      case 'pulse.reply': {
        const callId = message.callId as string;
        const answer = commands.get(callId);
        commands.delete(callId);
        answer?.(message);
        return;
      }
      case 'pulse.event':
        emit(message.name as string, message.payload);
        return;
      case 'pulse.result':
        resultWritten(message.requestId as string);
        return;
      case 'pulse.error':
        flowFailed(message.requestId as string, String(message.message));
        return;
      case 'pulse.upload':
        uploader(message);
        return;
    }
  });

  /** PulseKitBackground.swift's answers, with nothing ever running. */
  function uploader(m: Record<string, unknown>): void {
    const end = (fields: Record<string, unknown>) =>
      setTimeout(() => o.bus.deliver({ type: 'pulse.upload.end', id: m.id, ...fields }), 0);
    switch (m.op) {
      case 'hello':
        return void end({ ok: true });
      case 'sweep':
        return void end({ ok: true, cancelled: 0 });
      case 'attach':
        return void end({ ok: true, attached: false });
      case 'patch':
        patches.add(m.id as string);
        return;
      case 'cancel':
        if (patches.delete(m.id as string)) {
          end({ ok: false, error: { message: 'Cancelled.', canceled: true } });
        }
        return;
    }
  }

  /** One `pulse.cmd` to Pulse JS, answered by its `pulse.reply`. */
  function command(method: string, args: Json): Promise<Record<string, unknown>> {
    const callId = `n-${++callSeq}`;
    return new Promise((resolve) => {
      const send = () => {
        commands.set(callId, resolve);
        o.bus.deliver({ type: 'pulse.cmd', callId, method, args });
      };
      if (jsReady) send();
      else waitingForReady.push(send);
    });
  }

  // ── Pulse JS's runtime, booted on the signed-in account's library (as a first write would).
  startRuntimeServices({
    namespace: runtimeNamespace,
    config,
    network,
  });
  // The library gate has passed once the boot catalog is written.
  for (let i = 0; i < 500 && !existsSync(join(o.documents, 'catalog.json')); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!existsSync(join(o.documents, 'catalog.json'))) {
    throw new Error('createNodePulse: the runtime never wrote its catalog');
  }

  // ── Reads (PulseKitCatalog.swift over catalog.json).

  const net = (): NetworkView => ({
    online: network.online,
    wifi: network.wifi,
    wifiOnlyUploads: false,
  });

  async function catalog(): Promise<CatalogFile | null> {
    if (active !== runtimeNamespace) return null; // another account's folder: nothing written yet
    // The writer's next write, now: reads see the library as of the read.
    await startCatalogWriter({ namespace: runtimeNamespace, online: isOnline });
    return readCatalogFile((name) => {
      const path = join(o.documents, name);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    });
  }

  function needAccount(): string {
    if (active === null) throw new Refusal('no_account', 'No account is set (setAccount).');
    return active;
  }

  async function getDraft(id: string): Promise<CatalogDraft | null> {
    const c = await catalog();
    const row = c ? [...c.drafts, ...c.receipts].find((r) => r.id === id) : undefined;
    return row ? { ...row, state: shownState(row.state, net()) } : null;
  }

  async function usage(): Promise<Json> {
    const ns = needAccount();
    const c = await catalog();
    const rows = c?.drafts ?? [];
    const states = rows.map((r) => shownState(r.state, net()));
    return {
      namespace: ns,
      bytes: ns === runtimeNamespace ? folderBytes(o.documents) : 0,
      drafts: rows.length,
      unsent: rows.length,
      uploading: states.filter((s) => UPLOADING_STATES.has(s)).length,
      failed: states.filter((s) => s === 'failed').length,
      receipts: c?.receipts.length ?? 0,
    };
  }

  // ── The results inbox (PulseKitInbox.swift).

  const resultsDir = join(o.documents, 'results');

  function pending(): FlowResult[] {
    if (!existsSync(resultsDir)) return [];
    return readdirSync(resultsDir)
      .filter((n) => n.endsWith('.json') && !n.endsWith('.project.json'))
      .filter((n) => isPlainName(n.slice(0, -'.json'.length)))
      .map((n) => ({ n, t: statSync(join(resultsDir, n)).mtimeMs }))
      .sort((a, b) => a.t - b.t || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0))
      .map(({ n }) => JSON.parse(readFileSync(join(resultsDir, n), 'utf8')) as FlowResult);
  }

  function inboxResult(requestId: string): FlowResult | null {
    const path = join(resultsDir, `${requestId}.json`);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FlowResult) : null;
  }

  function acknowledge(requestId: string): void {
    for (const name of [`${requestId}.json`, `${requestId}.mp4`, `${requestId}.project.json`]) {
      rmSync(join(resultsDir, name), { force: true });
    }
  }

  function endFlow(f: Flow, result: FlowResult): void {
    if (f.ended) return;
    f.ended = true;
    f.cleanup();
    if (flow === f) flow = null;
    if (f.drop) return;
    emit('flowResult', result);
    f.resolve(clone(result));
  }

  function resultWritten(requestId: string): void {
    const f = flow;
    if (!f || f.requestId !== requestId) return;
    const result = inboxResult(requestId);
    if (result) endFlow(f, result);
  }

  function flowFailed(requestId: string, message: string): void {
    const f = flow;
    if (!f || f.requestId !== requestId) return;
    endFlow(f, {
      requestId,
      entry: f.request.entry,
      endedOn: null,
      stage: 'none',
      context: null,
      endedAt: Date.now(),
      status: 'failed',
      error: { code: 'runtime.error', message, recoverable: true, callId: '', requestId },
    });
  }

  // ── The person: one open's step, on the real flow store, reducer and controller.

  function nextStep(): FakeStep {
    const s = steps[Math.min(stepIndex, steps.length - 1)];
    stepIndex += 1;
    return s;
  }

  /** A clip on disk and in the library: a take in a new draft (record), or a clip added (edit). */
  async function take(f: Flow, draftId: string | null): Promise<{ id: string; clips: number }> {
    let id = draftId;
    if (!id) {
      const context = f.request.entry === 'record' ? f.request.context : null;
      id = await createDraft({
        name: f.step.result === 'sent' && f.step.name ? f.step.name : null,
        context: null,
        hostContext: context ? { ...context } : null,
        createdVia: 'host',
      });
    }
    const segmentId = `clip-${createHash('sha256').update(`${id}${Date.now()}${Math.random()}`).digest('hex').slice(0, 12)}`;
    const durationMs = (f.step.result === 'sent' && f.step.durationMs) || DEFAULT_CLIP_MS;
    const rel = writeOriginalBytes(id, segmentId, new Uint8Array(CLIP_BYTES).fill(7));
    await addSegment(id, { id: segmentId, originalFilename: rel, durationMs, thumbnail: null });
    return { id, clips: (await segmentsForDraft(id)).length };
  }

  /** Export's merge: the persisted export when current, else a "merge" written by hand. */
  async function merge(draftId: string): Promise<{ path: string; durationMs: number }> {
    const segments = await segmentsForDraft(draftId);
    const audio = exportAudio(await getRecorderFormat());
    return resolveMergedExport(draftId, segments, audio, async () => {
      const dir = join(cacheDir().uri.replace(/^file:\/\//, ''), 'merge');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${draftId}-${Date.now()}.mp4`);
      writeFileSync(path, new Uint8Array(CLIP_BYTES * segments.length).fill(9));
      return { path, durationMs: segments.reduce((n, s) => n + s.durationMs, 0) };
    });
  }

  function confirmedAt(draftId: string): number | null {
    const row = db
      .select({ at: drafts.hostConfirmedAt })
      .from(drafts)
      .where(eq(drafts.id, draftId))
      .get();
    return row?.at ?? null;
  }

  /** embed-app.tsx `finish`: the discarded draft goes, the result file, then `pulse.result`. */
  async function finish(f: Flow, state: FlowState): Promise<void> {
    if (state.deleteDraft) await removeDraft(state.deleteDraft).catch(() => {});
    const result = flowResult(state, Date.now());
    if (!result) return;
    // Fields a newer Pulse might add, as the script says.
    writeFlowResult({ ...result, ...(f.step.extra ?? {}) } as FlowResult);
    embedChannel().result(result.requestId);
  }

  async function play(f: Flow): Promise<void> {
    const { requestId, request, step } = f;
    const store = createFlowStore({ requestId, request, onEnd: (s) => void finish(f, s) });
    const controller = createFlowController(store, requestId);
    const letGo = holdFlowDraft(() => store.state().draftId);
    const stopClose = embedChannel().handle('close', async (args) => {
      await controller.hostClose(args.discard === true);
      return null;
    });
    f.cleanup = () => {
      letGo();
      stopClose();
    };
    const opened =
      request.entry === 'record'
        ? typeof request.draft === 'object'
          ? request.draft.continue
          : null
        : request.draftId;
    if (!controller.attach(opened)) {
      store.missing({
        code: 'not_found',
        message: `Pulse has no draft ${String(opened)}.`,
        recoverable: false,
        callId: '',
        requestId,
      });
      return;
    }
    store.dispatch({ type: 'mounted' });
    if (!(await pause(step.afterMs ?? 0, cancels)) || store.state().end) return;

    const ended = () => store.state().end !== null;
    const takeOne = async () => {
      if (request.entry === 'record') store.dispatch({ type: 'record' });
      const t = await take(f, store.state().draftId);
      if (ended()) return t.id;
      if (request.entry === 'record') {
        store.dispatch({ type: 'stop', draftId: t.id, clipCount: t.clips });
      } else {
        store.dispatch({ type: 'edited', clipCount: t.clips });
      }
      return t.id;
    };

    switch (step.result) {
      case 'discarded':
        store.dispatch({ type: 'close' });
        if (store.state().sheet) store.dispatch({ type: 'discard' });
        return;
      case 'failed':
        await controller.fail({
          code: step.code as never,
          message: `Scripted failure (${step.code}).`,
          ...(store.state().draftId ? { draftId: store.state().draftId as string } : {}),
        });
        return;
      case 'kept': {
        await takeOne();
        if (ended()) return;
        store.dispatch({ type: 'close' });
        if (store.state().sheet) store.dispatch({ type: 'keep' });
        return;
      }
      case 'file':
      case 'sent': {
        const draftId = await takeOne();
        if (ended()) return;
        // To Export: recorder → editor → export (the editor stays under it).
        if (request.entry === 'record') store.dispatch({ type: 'edit' });
        if (request.entry !== 'export') store.dispatch({ type: 'export' });
        const merged = await merge(draftId);
        if (ended()) return;
        store.dispatch({ type: 'merged' });
        if (step.result === 'file' || config.uploadMode === 'file') {
          await controller.useVideo({ draftId, path: merged.path, durationMs: merged.durationMs });
          return;
        }
        const own = db
          .select({ name: drafts.name, type: drafts.uploadTypeJson })
          .from(drafts)
          .where(eq(drafts.id, draftId))
          .get();
        const outcome = await runSend(
          {
            draftId,
            rules: uploadRulesOf(own?.type ? JSON.parse(own.type) : null),
            name: own?.name ?? null,
          },
          { isOnline, sendDraft, merge: () => merge(draftId), confirmedAt },
        );
        if (outcome.status === 'sent' && !ended()) controller.sent(outcome.sent);
        // Any other outcome leaves Export up, as the screen does: [Try again] / [Keep draft], X.
        return;
      }
    }
  }

  function open(args: Record<string, Json>): Promise<FlowResult> {
    const check = checkOpen(args);
    if (!check.ok) throw new Refusal('invalid_options', check.message);
    const requestId = check.requestId ?? `r-${++callSeq}-${Date.now()}`;
    if (flow && !flow.ended) {
      if (flow.requestId === requestId) return flow.done;
      throw new Refusal('busy', 'A flow is already open.');
    }
    needAccount();
    // The requestId's result still in the inbox: answered with it, nothing presented.
    const delivered = inboxResult(requestId);
    if (delivered) return Promise.resolve(delivered);
    let resolve!: (r: FlowResult) => void;
    const done = new Promise<FlowResult>((res) => (resolve = res));
    const f: Flow = {
      requestId,
      request: { ...(args as unknown as OpenRequest), requestId },
      step: nextStep(),
      drop: dropNext,
      done,
      resolve,
      ended: false,
      cleanup: () => {},
    };
    dropNext = false;
    flow = f;
    play(f).catch((e: unknown) => flowFailed(requestId, String(e)));
    return done;
  }

  // ── Native methods.

  function info(): PulseInfo {
    const base: PulseInfo = {
      sdkVersion: '0.0.0-node',
      build: '0',
      gitSha: 'node',
      contract: { major: 1, minor: FACADE_MINOR },
      formatVersion: 2,
      dbSchema: 0,
      entries: ['record', 'edit', 'export'],
      methods: [...MINOR0_METHODS, ...MINOR1_METHODS],
      capabilities: ['upload.pulse', 'upload.file', 'headless'],
      platform: 'ios',
      osVersion: '18.0',
      supported: true,
      namespace: active,
    };
    return { ...base, ...(o.info as Partial<PulseInfo>), namespace: active };
  }

  async function forward(method: string, args: Json): Promise<unknown> {
    const ns = needAccount();
    if (ns !== runtimeNamespace) {
      throw new Refusal('restart_required', "Pulse has another account's library open.");
    }
    const reply = await command(method, args);
    if (reply.ok === true) return reply.result ?? null;
    const error = isObject(reply.error) ? reply.error : {};
    throw Object.assign(new Refusal(String(error.code ?? 'unknown'), String(error.message)), {
      fields: error,
    });
  }

  async function handle(method: string, a: Record<string, Json>): Promise<unknown> {
    if (FORWARDED.has(method)) return forward(method, a);
    switch (method) {
      case 'info':
        return info();
      case 'configure': {
        const problem = checkConfigure(a);
        if (problem) throw new Refusal('invalid_options', problem);
        config = { ...a };
        await command('configure', config);
        return null;
      }
      case 'prewarm':
        return null;
      case 'open':
        return open(a);
      case 'close': {
        const f = flow;
        if (!f || f.ended) return null;
        await command('close', a);
        return null;
      }
      case 'isOpen':
        return flow !== null && !flow.ended;
      case 'pendingResults':
        return active === null ? [] : pending();
      case 'acknowledge':
        if (!isPlainName(a.requestId))
          throw new Refusal('invalid_options', 'requestId is required.');
        if (active !== null) acknowledge(a.requestId);
        return null;
      case 'logFile':
        return { rel: 'logs/pulse.log', path: join(o.documents, 'logs/pulse.log'), webUrl: '' };
      case 'setAccount': {
        if (flow && !flow.ended) throw new Refusal('busy', 'A flow is open.');
        if (typeof a.serverOrigin !== 'string' || typeof a.userId !== 'string') {
          active = null;
        } else {
          active = namespaceOf(String(config.hostId ?? o.hostId), {
            serverOrigin: a.serverOrigin,
            userId: a.userId,
          });
        }
        await command('accountActive', { active: active === runtimeNamespace });
        return { namespace: active };
      }
      case 'listDrafts': {
        needAccount();
        const c = await catalog();
        return c ? listDrafts(c, a as unknown as DraftFilter, net()) : [];
      }
      case 'getDraft':
        needAccount();
        return getDraft(String(a.id));
      case 'countDrafts': {
        needAccount();
        const c = await catalog();
        return c ? countDrafts(c, a as unknown as CountOptions, net()) : {};
      }
      case 'usage':
        return usage();
      case 'listNamespaces': {
        const u = active === runtimeNamespace ? ((await usage()) as Record<string, number>) : null;
        return [
          {
            namespace: runtimeNamespace,
            hostId: o.hostId,
            serverOrigin: o.account.serverOrigin,
            bytes: folderBytes(o.documents),
            unsent: u?.unsent ?? 0,
            lastUsedAt: Date.now(),
            active: active === runtimeNamespace,
          },
        ];
      }
      case 'purge':
        throw new Refusal('busy', "This facade can't restart Pulse's runtime after a purge.");
      case 'respondHostRequest':
        o.bus.deliver({
          type: 'pulse.respond',
          hostCallId: a.hostCallId,
          ...(a.error !== undefined ? { error: a.error } : { result: a.result ?? null }),
        });
        return null;
      default:
        throw new Refusal('method.unsupported', `This PulseKit doesn't answer ${method}.`);
    }
  }

  const adapter: PulseAdapter = {
    kind: 'node',
    present: () => Promise.resolve(true),
    async call(method, args, callId) {
      const i = info();
      const routed = routeRequest(
        { v: 1, callId, method, args: args ?? {}, client: { contract: { major: 1 } } },
        { methods: i.methods, supported: i.supported },
      );
      if (routed.route === 'reply') return routed.reply;
      try {
        const result = await handle(routed.method, routed.args);
        return buildReply({ ok: true, callId, result: (clone(result) ?? null) as Json });
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        const fields = (e as Refusal & { fields?: Record<string, Json> }).fields ?? {};
        return buildReply({
          ok: false,
          callId,
          error: { ...fields, code: e.code, message: e.message } as never,
        }) as BridgeReply;
      }
    },
    subscribe(cb) {
      subscribers.add(cb);
      if (retained.length > 0) {
        void Promise.resolve().then(() => {
          for (const e of retained.splice(0)) for (const s of [...subscribers]) s(e);
        });
      }
      return () => {
        subscribers.delete(cb);
      };
    },
    toWebUrl: (path) => `nodepulse://local${path}`,
  };

  let client: PulseClient | null = null;

  return {
    adapter,
    get client() {
      client ??= createPulseClient({ adapter });
      return client;
    },
    reload() {
      subscribers.clear();
      client = createPulseClient({ adapter });
      return client;
    },
    async setOnline(online) {
      network = { ...network, online };
      await command('network', network);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const cancel of [...cancels]) cancel();
      flow?.cleanup();
      flow = null;
      const released = new Promise<void>((resolve) => {
        const stop = o.bus.listen((m) => {
          if (m.type === 'pulse.released') {
            stop();
            resolve();
          }
        });
      });
      await command('releaseLibrary', {});
      await released;
      stopListening();
    },
  };
}
