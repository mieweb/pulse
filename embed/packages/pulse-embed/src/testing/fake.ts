import { createPulseClient } from '../client';
import { buildReply, buildRequest, CONTRACT, newRequestId, routeRequest } from '../envelope';
import { isRecoverableCode } from '../errors';
import type {
  BridgeEvent,
  BridgeReply,
  ConfirmSendRequest,
  ConfirmSendResult,
  DraftReceipt,
  DraftState,
  DraftSummary,
  FakeFlowStep,
  FakePulse,
  FakePulseScript,
  FileRef,
  FlowResult,
  HostRequestMethod,
  HostServiceError,
  Json,
  MethodName,
  PulseAccount,
  PulseAdapter,
  PulseClient,
  PulseContext,
  PulseErrorCode,
  PulseErrorInfo,
  PulseInfo,
  UploadTarget,
  UploadTargetRequest,
} from '../types';
import { checkConfigure, checkOpen, isPlainName } from '../validate';
import { pollOutcome, sizeOf, TusError, uploadArtifact, type FetchLike } from './tus';

/**
 * createFakePulse: a scripted, in-memory Pulse facade behind a real PulseAdapter, so a host's
 * client code (and its tests, Playwright runs and dev builds) talks to it exactly as it would to
 * the Capacitor or Cordova plugin. Requests are routed with the facade rules the Swift side shares
 * (envelope.ts `routeRequest`), so `method.unsupported`, `unsupported` and unknown-field handling
 * match the real facade.
 *
 * A host page installs it before its first `getPulse()`:
 *
 *   const fake = createFakePulse({ flows: [{ result: 'sent' }] });
 *   window.__PULSE_ADAPTER__ = fake.adapter;
 *
 * Flows (open) follow `script.flows`, one step per open, repeating the last. The data API (drafts,
 * outbox states, locks, receipts, accounts) follows the real Pulse JS code: the same contract
 * suite (runPulseContract) runs against both (embed/src/test-support/contract-parity.test.ts), and
 * where they differed the fake was changed. What the suite can't reach (the fake's own TUS client,
 * `transition`, namespaces hashed with FNV-1a instead of SHA-256) is the fake's own model.
 */

/** A flow step, plus how long the flow stays open and fields a newer facade might add. */
export type FakeStep = FakeFlowStep & {
  /** How long the flow stays open before it ends, in ms. Default: `script.latencyMs`, else 0. */
  afterMs?: number;
  /** Merged into the FlowResult as is: fields a newer facade might send. */
  extra?: { [key: string]: Json };
};

/** Simulated outbox moves for a job, without a server (the fake's own model). */
export type FakeUploadEvent =
  | { type: 'uploading'; progress?: number }
  | { type: 'delivering' }
  | { type: 'needs_credentials' }
  | { type: 'failed'; code?: PulseErrorCode; message?: string }
  | { type: 'delivered'; outcome: 'done' | 'kept'; note?: string; reason?: string };

/** One related artifact the server mode sends before the video (captions, beats, thumbnail). */
export interface FakeRelatedPart {
  kind: 'captions' | 'project' | 'thumbnail';
  filename: string;
  fixture: Blob | ArrayBuffer;
}

export interface FakeScript extends Omit<FakePulseScript, 'flows' | 'server' | 'info'> {
  /** Merged over the fake's info; may carry fields a newer facade sends. */
  info?: Partial<PulseInfo> & { [key: string]: unknown };
  flows?: FakeStep[];
  /**
   * With a server, the fake uploads for real after Send: getUploadTarget through the host's
   * HostServices, a fetch-based TUS create + PATCH of `fixture` (and `related` first, each
   * `relatedTo` the video) to the target's `endpoint`, then it polls
   * `<endpoint>/artifacts/<id>/status` every `pollMs` (default 1000) until the host records an
   * outcome, and retires the draft into a receipt.
   */
  server?: {
    fixture: Blob | ArrayBuffer;
    pollMs?: number;
    related?: FakeRelatedPart[];
    /** Default: the global `fetch` (called unbound, so it works in a browser). */
    fetch?: FetchLike;
  };
  /**
   * The signed-in account at start. Default: a fixed test account, so data calls work without
   * `setAccount`; `null` starts signed out (data calls reject `no_account`).
   *
   * Seeded drafts (`drafts`) belong to the person the page signs in first: they sit in this
   * account's namespace (keyed by the `hostId` the page configures) until the page's first
   * `setAccount` with an account, and then move to that account's namespace, so a host that binds
   * its own hostId and signed-in user finds them without knowing the fake's ids.
   */
  account?: PulseAccount | null;
  /** Default: `fakepulse://local<path>`. */
  toWebUrl?: (path: string) => string;
  /** Default: Date.now. */
  now?: () => number;
  /** Starts offline (queued jobs read `waiting_network`). Default true. */
  online?: boolean;
}

export interface FakePulseHandle extends FakePulse {
  /** The current page's client, made on first use; `reload()` replaces it. */
  readonly client: PulseClient;
  /**
   * Simulates a WebView reload: the old page's listeners are gone (events retain for the next
   * subscriber, as the plugins do) and a new client on the same adapter is returned.
   */
  reload(): PulseClient;
  /** The next open's result goes only to the inbox: no reply, no flowResult event. */
  dropNextResult(): void;
  /** Every row in the active namespace (receipts too), as the catalog holds it (webUrl ''). */
  drafts(): DraftSummary[];
  /** Every hostRequest payload the fake sent, oldest first. */
  hostRequests: { hostCallId: string; method: string; args: Json; deadline: number }[];
  /** Moves a draft's job without a server (the fake's own model). Throws when it has no job. */
  transition(draftId: string, e: FakeUploadEvent): void;
  /** Resolves once no flow is ending and no upload is running (a flow left open by a failed confirmSend counts as idle). */
  idle(): Promise<void>;
  /** Stops every timer and upload. */
  dispose(): void;
}

// ─── Defaults ───────────────────────────────────────────────────────────────────────────────────

// Every method the fake answers. A Record over MethodName so tsc fails when types.ts gains one.
const METHODS: Record<MethodName, true> = {
  info: true,
  configure: true,
  prewarm: true,
  open: true,
  close: true,
  isOpen: true,
  pendingResults: true,
  acknowledge: true,
  logFile: true,
  setAccount: true,
  listDrafts: true,
  getDraft: true,
  countDrafts: true,
  renameDraft: true,
  deleteDraft: true,
  setDraftContext: true,
  upload: true,
  cancelUpload: true,
  retireDraft: true,
  dismissReceipt: true,
  resumeOutbox: true,
  usage: true,
  listNamespaces: true,
  purge: true,
  respondHostRequest: true,
};

export const FAKE_ACCOUNT: PulseAccount = Object.freeze({
  serverOrigin: 'https://host.fake',
  userId: 'fake-user',
});

const DEFAULT_HOST_ID = 'fake.host';
/** The contract minor this facade answers: minor 1, the data API (like PulseKit.contractMinor). */
const FACADE_MINOR = 1;
const HOST_DEADLINE_MS = 20_000;
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DURATION_MS = 5_000;
const DEFAULT_BYTES = 1_048_576;

const LOCKED: readonly string[] = ['preparing', 'uploading', 'delivering', 'sent'];
/** The job states that lock a draft against the host's writes (PLAN §6.1). */
const JOB_LOCKED: readonly string[] = ['preparing', 'uploading', 'delivering'];

/** A host context Pulse stores (host-context.ts `hostContextColumns`), or why not. */
function contextProblem(c: unknown): string | null {
  if (!isObject(c)) return 'The context must be an object.';
  if (
    typeof c.key !== 'string' ||
    c.key.length > 128 ||
    !/^[a-z0-9._-]+:[a-z0-9._:-]+$/.test(c.key)
  ) {
    return 'The context key must be kind:id, 1–128 chars of [a-z0-9._:-].';
  }
  if (typeof c.label !== 'string' || c.label.trim().length === 0) {
    return 'The context label must not be blank.';
  }
  if (Array.from(c.label).length > 120) return 'The context label must be at most 120 characters.';
  return null;
}

/** The codes a host's refusal keeps (host-services.ts HOST_CODES); any other is host.unavailable. */
const HOST_CODES: readonly string[] = [
  'destination.gone',
  'upload.refused',
  'upload.too_large',
  'no_account',
  'host.unavailable',
];
/** The host refusals that fail a job for good (outbox.ts `hostErrorEvent`). */
const PERMANENT_HOST_CODES: readonly string[] = [
  'destination.gone',
  'upload.refused',
  'upload.too_large',
];

type JobState =
  'preparing' | 'queued' | 'uploading' | 'delivering' | 'needs_credentials' | 'failed';
const JOB_STATES: readonly string[] = [
  'preparing',
  'queued',
  'uploading',
  'delivering',
  'needs_credentials',
  'failed',
];

// The job and draft rows below are the fake's model of upload_jobs / drafts / receipts.
interface Job {
  state: JobState;
  clientKey: string;
  sentAt: number;
  attempts: number;
  uploadId?: string;
  artifactId?: string;
  progress?: number;
  error?: PulseErrorInfo;
  /** Server mode: set while a runner owns the job. */
  abort?: AbortController;
  token?: string;
}

interface Row {
  id: string;
  draftKey: string;
  /** Its own name, or null: then it is shown by its place's label (drafts.ts draftDisplayName). */
  name: string | null;
  context: PulseContext | null;
  clipCount: number;
  durationMs: number;
  bytes?: number;
  hasCaptions: boolean;
  confirmedAt?: number;
  /** The sentAt the host confirmed with: a later Send keeps it (AD23). */
  confirmedSentAt?: number;
  /** The export is current ('ready' without a job). */
  exported: boolean;
  /**
   * The draft's cut (its clips as they are): a Send's clientKey is the draftKey plus a hash of it
   * (client-key.ts), so a Send of the same cut has the same clientKey. A take or an edit changes
   * it; a rename or a move doesn't.
   */
  cut: string;
  job?: Job;
  receipt?: DraftReceipt;
  createdVia: 'app' | 'host';
  createdAt: number;
  updatedAt: number;
  /** Seeded fields the fake doesn't model, returned as is (a newer facade's fields). */
  extra: { [key: string]: Json };
}

interface Space {
  account: PulseAccount;
  hostId: string;
  rows: Map<string, Row>;
  lastUsedAt: number;
}

interface Flow {
  requestId: string;
  callId: string;
  entry: 'record' | 'edit' | 'export';
  context: PulseContext | null;
  /** The draft the flow holds (an existing one, or the take once there is one). */
  draftId?: string;
  /** The draft existed before this flow (edit, export, record continue). */
  existing: boolean;
  step: FakeStep;
  drop: boolean;
  done: Promise<FlowResult>;
  resolve: (r: FlowResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Settles the flow's tracked ending (idle()). */
  settle: () => void;
  /** Send's confirmSend failed: Pulse stays open on Export until the person (or host) closes. */
  waiting: boolean;
  ended: boolean;
}

class Failure extends Error {
  constructor(
    readonly code: PulseErrorCode,
    message: string,
    readonly extra: Partial<PulseErrorInfo> = {},
  ) {
    super(message);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Two FNV-1a passes → 16 hex chars: a stable stand-in for the facade's SHA-256 prefix (§4). */
function hash16(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 ^ 0x2f) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function hex(n: number): string {
  return newRequestId().replace(/-/g, '').slice(0, n);
}

function originOf(serverOrigin: string): string {
  try {
    return new URL(serverOrigin).origin.toLowerCase();
  } catch {
    return serverOrigin.toLowerCase();
  }
}

const KNOWN_SUMMARY_KEYS = new Set([
  'id',
  'draftKey',
  'name',
  'context',
  'state',
  'clipCount',
  'durationMs',
  'bytes',
  'hasCaptions',
  'confirmedAt',
  'poster',
  'export',
  'upload',
  'sent',
  'createdVia',
  'createdAt',
  'updatedAt',
]);

// ─── The fake ───────────────────────────────────────────────────────────────────────────────────

export function createFakePulse(script: FakeScript = {}): FakePulseHandle {
  const now = script.now ?? (() => Date.now());
  const steps: FakeStep[] =
    script.flows && script.flows.length > 0 ? script.flows : [{ result: 'sent' }];
  // The global fetch is called through a wrapper: a browser's `fetch` called as a method of
  // another object throws "Illegal invocation".
  const fetchImpl: FetchLike | undefined =
    script.server?.fetch ??
    (typeof fetch === 'function'
      ? (url, init) => (fetch as unknown as FetchLike)(url, init)
      : undefined);
  const installationId = `fake-${hex(8)}`;

  let stepIndex = 0;
  let dropNext = script.dropNextResult === true;
  let online = script.online !== false;
  let disposed = false;
  let configured: { uploadMode: 'pulse' | 'file'; hostId: string } = {
    uploadMode: 'pulse',
    hostId: DEFAULT_HOST_ID,
  };

  const spaces = new Map<string, Space>();
  let active: string | null = null;
  let flow: Flow | null = null;
  let last: FlowResult | null = null;
  // The durable inbox (results/<requestId>.json), oldest first.
  const inbox = new Map<string, FlowResult>();
  const calls: { method: string; args: Json }[] = [];
  const hostRequests: FakePulseHandle['hostRequests'] = [];
  const hostWaits = new Map<
    string,
    {
      resolve: (v: Json) => void;
      reject: (e: HostServiceError) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const work = new Set<Promise<unknown>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  // ── Events: one fan-out; flowResult and hostRequest wait for a subscriber (native-bridge.md §7).
  const subscribers = new Set<(e: BridgeEvent) => void>();
  const retained: BridgeEvent[] = [];

  function deliver(e: BridgeEvent): void {
    for (const cb of [...subscribers]) {
      try {
        cb(e);
      } catch (err) {
        console.error('[pulse-embed/testing] a subscriber threw', err);
      }
    }
  }

  function emitEvent(name: string, payload: unknown): void {
    const e: BridgeEvent = { v: 1, name, payload: clone(payload) as Json };
    if (subscribers.size === 0) {
      if (name === 'flowResult' || name === 'hostRequest') retained.push(e);
      return;
    }
    deliver(e);
  }

  function later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  }

  // Sleepers wake early on dispose(), so a runner waiting between polls ends instead of hanging.
  const wakers = new Set<() => void>();

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        wakers.delete(wake);
        clearTimeout(t);
        resolve();
      };
      const t = later(ms, wake);
      wakers.add(wake);
    });
  }

  function track<T>(p: Promise<T>): Promise<T> {
    work.add(p);
    const forget = () => work.delete(p);
    p.then(forget, forget);
    return p;
  }

  // ── Accounts and rows ──────────────────────────────────────────────────────────────────────────

  function namespaceFor(a: PulseAccount, hostId: string): string {
    return `${hostId}-${hash16(`${originOf(a.serverOrigin)}\n${a.userId}`)}`;
  }

  function space(ns: string, a: PulseAccount, hostId: string): Space {
    let s = spaces.get(ns);
    if (!s) spaces.set(ns, (s = { account: a, hostId, rows: new Map(), lastUsedAt: now() }));
    return s;
  }

  // The seeded drafts' namespace: the starting account's, until the page's first setAccount with
  // an account takes them over (`bindSeeds`); a configure before that re-keys it by its hostId.
  const seedAccount = script.account ?? FAKE_ACCOUNT;
  let seedNs = namespaceFor(seedAccount, DEFAULT_HOST_ID);
  let seedSpace = space(seedNs, seedAccount, DEFAULT_HOST_ID);
  let seedsBound = false;
  active = script.account === null ? null : seedNs;

  /** configure before any sign-in: the starting namespace is keyed by the host's own hostId. */
  function rekeySeeds(hostId: string): void {
    if (seedsBound || seedSpace.hostId === hostId) return;
    const ns = namespaceFor(seedSpace.account, hostId);
    spaces.delete(seedNs);
    seedSpace = { ...seedSpace, hostId };
    spaces.set(ns, seedSpace);
    if (active === seedNs) active = ns;
    seedNs = ns;
  }

  /** The page's first sign-in: the seeded drafts move to that account's namespace. */
  function bindSeeds(ns: string, s: Space): void {
    if (seedsBound) return;
    seedsBound = true;
    if (ns === seedNs) return;
    for (const [id, r] of seedSpace.rows) s.rows.set(id, r);
    spaces.delete(seedNs);
  }

  function root(): string {
    return `/fake/PulseKit/${active ?? '_'}`;
  }

  function fileRef(rel: string, bytes?: number): FileRef {
    return { rel, path: `${root()}/${rel}`, webUrl: '', ...(bytes === undefined ? {} : { bytes }) };
  }

  function stateOf(r: Row): DraftState {
    if (r.receipt) return 'sent';
    if (r.job) {
      // The facade derives waiting_network from the network, never from the catalog (§6.1).
      if (r.job.state === 'queued' && !online) return 'waiting_network';
      return r.job.state;
    }
    return r.exported ? 'ready' : 'draft';
  }

  function summary(r: Row): DraftSummary {
    const state = stateOf(r);
    const s: DraftSummary = {
      ...(r.extra as object),
      id: r.id,
      draftKey: r.draftKey,
      name: displayName(r),
      context: r.context,
      state,
      clipCount: r.clipCount,
      durationMs: r.durationMs,
      hasCaptions: r.hasCaptions,
      poster: r.receipt ? null : fileRef(`drafts/${r.id}/poster.jpg`),
      createdVia: r.createdVia,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
    if (r.bytes !== undefined) s.bytes = r.bytes;
    if (r.confirmedAt !== undefined) s.confirmedAt = r.confirmedAt;
    if (!r.receipt && (r.exported || r.job))
      s.export = fileRef(`drafts/${r.id}/export.mp4`, r.bytes);
    if (r.job) {
      s.upload = {
        clientKey: r.job.clientKey,
        attempts: r.job.attempts,
        sentAt: r.job.sentAt,
        ...(r.job.uploadId ? { uploadId: r.job.uploadId } : {}),
        ...(r.job.artifactId ? { artifactId: r.job.artifactId } : {}),
        ...(r.job.progress === undefined ? {} : { progress: r.job.progress }),
        ...(r.job.error ? { error: r.job.error } : {}),
      };
    }
    if (r.receipt) s.sent = r.receipt;
    return s;
  }

  function rowFromSeed(d: DraftSummary): Row {
    const extra: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(d)) {
      if (!KNOWN_SUMMARY_KEYS.has(k)) extra[k] = v as Json;
    }
    const state = d.state as string;
    const r: Row = {
      id: d.id,
      draftKey: d.draftKey ?? `${installationId}:${d.id}`,
      name: d.name,
      context: d.context ?? null,
      clipCount: d.clipCount ?? 1,
      durationMs: d.durationMs ?? DEFAULT_DURATION_MS,
      hasCaptions: d.hasCaptions === true,
      exported: state !== 'draft',
      cut: hex(16),
      createdVia: d.createdVia ?? 'host',
      createdAt: d.createdAt ?? now(),
      updatedAt: d.updatedAt ?? now(),
      extra,
    };
    if (d.bytes !== undefined) r.bytes = d.bytes;
    if (d.confirmedAt !== undefined) {
      r.confirmedAt = d.confirmedAt;
      r.confirmedSentAt = d.upload?.sentAt ?? d.confirmedAt;
    }
    if (state === 'sent') {
      r.receipt = d.sent ?? {
        outcome: 'done',
        uploadId: d.upload?.uploadId ?? '',
        artifactId: d.upload?.artifactId ?? '',
        sentAt: d.upload?.sentAt ?? r.updatedAt,
        at: r.updatedAt,
        expiresAt: r.updatedAt + RECEIPT_TTL_MS,
        dismissed: false,
      };
    } else if (JOB_STATES.includes(state) || state === 'waiting_network') {
      // A seeded waiting_network is a queued job: the fake derives the state from setOnline.
      r.job = {
        state: state === 'waiting_network' ? 'queued' : (state as JobState),
        clientKey: d.upload?.clientKey ?? clientKeyOf(r),
        sentAt: d.upload?.sentAt ?? r.updatedAt,
        attempts: d.upload?.attempts ?? 0,
        ...(d.upload?.uploadId ? { uploadId: d.upload.uploadId } : {}),
        ...(d.upload?.artifactId ? { artifactId: d.upload.artifactId } : {}),
        ...(d.upload?.progress === undefined ? {} : { progress: d.upload.progress }),
        ...(d.upload?.error ? { error: d.upload.error } : {}),
      };
    }
    return r;
  }

  for (const d of script.drafts ?? []) {
    const r = rowFromSeed(d);
    seedSpace.rows.set(r.id, r);
  }

  function rows(): Map<string, Row> {
    if (active === null) throw new Failure('no_account', 'No account is set (setAccount).');
    const s = spaces.get(active);
    if (!s) throw new Failure('no_account', 'No account is set (setAccount).');
    return s.rows;
  }

  function needsAccount(): boolean {
    return info().methods.includes('setAccount');
  }

  function row(id: unknown): Row {
    const r = typeof id === 'string' ? rows().get(id) : undefined;
    if (!r) throw new Failure('not_found', `No draft ${String(id)}.`, { draftId: String(id) });
    return r;
  }

  function changed(ids: string[]): void {
    if (active === null || ids.length === 0) return;
    emitEvent('draftsChanged', { namespace: active, ids });
  }

  /** What a draft is called where it's shown: its own name, else its place's label. */
  function displayName(r: Row): string {
    return r.name || r.context?.label || 'Untitled';
  }

  function touch(r: Row): void {
    r.updatedAt = Math.max(now(), r.updatedAt + 1);
  }

  /** PLAN §6.1 lock rule: locked states, and the draft the open flow holds. */
  function assertUnlocked(r: Row): void {
    const state = stateOf(r);
    if (LOCKED.includes(state)) {
      throw new Failure('draft.locked', `The draft is ${state}.`, { draftId: r.id });
    }
    if (flow && !flow.ended && flow.draftId === r.id) {
      throw new Failure('draft.locked', 'The draft is open in Pulse.', { draftId: r.id });
    }
  }

  /** A draft (not a receipt) by id: a receipt is no draft to the commands (router.ts). */
  function draftRow(id: unknown): Row {
    const r = row(id);
    if (r.receipt) throw new Failure('not_found', `No draft ${r.id}.`, { draftId: r.id });
    return r;
  }

  /**
   * The commands' lock check (router.ts `checkDraft`): the draft the open flow holds, then the
   * job states that lock this command (default: preparing, uploading, delivering).
   */
  function checkLock(r: Row, lockedStates: readonly string[] = JOB_LOCKED): void {
    if (flow && !flow.ended && flow.draftId === r.id) {
      throw new Failure('draft.locked', `Draft ${r.id} is open in Pulse.`, { draftId: r.id });
    }
    if (r.job && lockedStates.includes(r.job.state)) {
      throw new Failure('draft.locked', `Draft ${r.id} is ${r.job.state}.`, { draftId: r.id });
    }
  }

  /**
   * `upload(id)` (outbox.ts `sendDraft`): a job already queued or paused answers with its keys; one
   * under way refuses `draft.locked`; otherwise the type's `maxBytes` and, once per draft, its
   * `confirmSend` (a clock-bound draft keeps its first sentAt), then a new job.
   */
  async function hostSend(r: Row): Promise<Json> {
    checkLock(r, []);
    const job = r.job;
    if (job && (job.state === 'queued' || job.state === 'needs_credentials')) {
      return { clientKey: job.clientKey, draftKey: r.draftKey, sentAt: job.sentAt };
    }
    if (job && job.state !== 'failed') {
      throw new Failure('draft.locked', `Draft ${r.id} is ${job.state}.`, { draftId: r.id });
    }
    const bytes = r.bytes ?? fixtureBytes();
    const type = r.context?.uploadType;
    if (typeof type?.maxBytes === 'number' && bytes > type.maxBytes) {
      throw new Failure(
        'upload.too_large',
        `Draft ${r.id} is ${bytes} bytes, over its upload type's ${type.maxBytes}.`,
        { draftId: r.id },
      );
    }
    let sentAt = now();
    if (r.confirmedAt !== undefined) {
      sentAt = r.confirmedSentAt ?? sentAt;
    } else if (type?.confirmSend) {
      let answer: ConfirmSendResult;
      try {
        answer = (await askHost('confirmSend', {
          draftId: r.id,
          draftKey: r.draftKey,
          context: r.context as PulseContext,
          uploadType: type,
          sentAt,
          bytes,
        })) as unknown as ConfirmSendResult;
      } catch (e) {
        const err = hostErrorOf(e);
        throw new Failure(err.code as PulseErrorCode, err.message, { draftId: r.id });
      }
      r.confirmedAt = typeof answer?.confirmedAt === 'number' ? answer.confirmedAt : now();
      r.confirmedSentAt = sentAt;
    }
    const queued = queue(r, sentAt);
    changed([r.id]);
    startUpload(r);
    return { clientKey: queued.clientKey, draftKey: r.draftKey, sentAt: queued.sentAt };
  }

  function newRow(context: PulseContext | null, step: FakeStep): Row {
    const id = newRequestId();
    const t = now();
    return {
      id,
      draftKey: `${installationId}:${id}`,
      name: step.result === 'sent' && step.name ? step.name : null,
      context: clone(context),
      clipCount: 1,
      durationMs: (step.result === 'sent' && step.durationMs) || DEFAULT_DURATION_MS,
      hasCaptions: false,
      exported: false,
      cut: hex(16),
      createdVia: 'host',
      createdAt: t,
      updatedAt: t,
      extra: {},
    };
  }

  function fixtureBytes(): number {
    return script.server ? sizeOf(script.server.fixture) : DEFAULT_BYTES;
  }

  function receiptFor(r: Row, outcome: 'done' | 'kept', o: { note?: string; reason?: string }) {
    const at = now();
    const receipt: DraftReceipt = {
      outcome,
      uploadId: r.job?.uploadId ?? '',
      artifactId: r.job?.artifactId ?? '',
      sentAt: r.job?.sentAt ?? at,
      at,
      expiresAt: at + RECEIPT_TTL_MS,
      dismissed: false,
      ...(o.note === undefined ? {} : { note: o.note }),
      ...(o.reason === undefined ? {} : { reason: o.reason }),
    };
    return receipt;
  }

  /** Retirement (pulse-schema.md §4.3): the draft becomes a receipt; its media is gone. */
  function retire(r: Row, outcome: 'done' | 'kept', o: { note?: string; reason?: string } = {}) {
    r.receipt = receiptFor(r, outcome, o);
    r.job?.abort?.abort();
    r.job = undefined;
    r.exported = false;
    touch(r);
    changed([r.id]);
  }

  /**
   * A job's last error as the catalog projects it (catalog.ts `uploadOf`): its code and message,
   * recoverable unless the job failed, and no callId (no call made it).
   */
  function jobError(code: string, message: string, state: JobState): PulseErrorInfo {
    return { code: code as PulseErrorCode, message, recoverable: state !== 'failed', callId: '' };
  }

  // ── Host requests ────────────────────────────────────────────────────────────────────────────

  function askHost(method: HostRequestMethod, args: unknown): Promise<Json> {
    const hostCallId = `h-${hex(12)}`;
    // Wall-clock, not script.now: the client drops a request whose deadline has passed by Date.now.
    const deadline = Date.now() + HOST_DEADLINE_MS;
    const payload = { hostCallId, method, args: clone(args) as Json, deadline };
    hostRequests.push(clone(payload));
    return new Promise<Json>((resolve, reject) => {
      const timer = later(HOST_DEADLINE_MS, () => {
        hostWaits.delete(hostCallId);
        reject({
          code: 'host.unavailable',
          message: `The host didn't answer ${method} in 20 s.`,
          unanswered: true,
        });
      });
      hostWaits.set(hostCallId, { resolve, reject, timer });
      emitEvent('hostRequest', payload);
    });
  }

  function respondHostRequest(args: Record<string, Json>): null {
    const id = args.hostCallId;
    const wait = typeof id === 'string' ? hostWaits.get(id) : undefined;
    if (!wait || typeof id !== 'string') return null; // unknown or expired: a no-op (§3)
    hostWaits.delete(id);
    clearTimeout(wait.timer);
    timers.delete(wait.timer);
    if (isObject(args.error)) {
      const e = args.error;
      wait.reject({
        code: (typeof e.code === 'string'
          ? e.code
          : 'host.unavailable') as HostServiceError['code'],
        message: typeof e.message === 'string' ? e.message : 'The host refused.',
      });
    } else {
      wait.resolve(args.result ?? null);
    }
    return null;
  }

  /**
   * A host refusal as Pulse reads it (host-services.ts `hostError`): one of the contract's codes
   * stays, anything else is `host.unavailable`; `unanswered` when nobody answered in time.
   */
  function hostErrorOf(e: unknown): HostServiceError & { unanswered: boolean } {
    const unanswered = isObject(e) && e.unanswered === true;
    if (isObject(e) && typeof e.code === 'string' && HOST_CODES.includes(e.code)) {
      return {
        code: e.code as HostServiceError['code'],
        message: String(e.message ?? e.code),
        unanswered,
      };
    }
    const message = isObject(e) && typeof e.message === 'string' ? e.message : String(e);
    return { code: 'host.unavailable', message, unanswered };
  }

  // ── The outbox ─────────────────────────────────────────────────────────────────────────────────

  /** `<draftKey>:<16 hex of the cut>` (client-key.ts `jobKeys`). */
  function clientKeyOf(r: Row): string {
    return `${r.draftKey}:${hash16(r.cut)}`;
  }

  function queue(r: Row, sentAt: number): Job {
    r.job?.abort?.abort();
    const job: Job = {
      state: 'queued',
      clientKey: clientKeyOf(r),
      sentAt,
      attempts: 0,
    };
    r.job = job;
    r.exported = true;
    r.bytes ??= fixtureBytes();
    touch(r);
    return job;
  }

  function startUpload(r: Row): void {
    const job = r.job;
    if (!script.server || !fetchImpl || !job || job.abort || disposed) return;
    if (job.state !== 'queued' || !online) return;
    const abort = new AbortController();
    job.abort = abort;
    void track(runUpload(r, job, abort, script.server, fetchImpl));
  }

  async function runUpload(
    r: Row,
    job: Job,
    abort: AbortController,
    server: NonNullable<FakeScript['server']>,
    fetchFn: FetchLike,
  ): Promise<void> {
    const live = () => !disposed && !abort.signal.aborted && r.job === job;
    const bytes = sizeOf(server.fixture);
    const request: UploadTargetRequest = {
      draftId: r.id,
      clientKey: job.clientKey,
      draftKey: r.draftKey,
      context: r.context as PulseContext,
      name: displayName(r),
      durationMs: r.durationMs,
      bytes,
      sentAt: job.sentAt,
      // `attempts` counts the asks that got an answer, or a retryable refusal (outbox.ts).
      attempt: job.attempts + 1,
      renewArtifact: false,
    };
    let target: UploadTarget;
    try {
      target = (await askHost('getUploadTarget', request)) as unknown as UploadTarget;
    } catch (e) {
      if (!live()) return;
      // As the outbox reads a host refusal (outbox.ts `hostErrorEvent`): its own codes fail the
      // job, no_account and a host that never answered pause it, anything else is retried.
      const err = hostErrorOf(e);
      job.abort = undefined;
      if (PERMANENT_HOST_CODES.includes(err.code)) {
        job.state = 'failed';
      } else if (err.code === 'no_account' || err.unanswered) {
        job.state = 'needs_credentials';
      } else {
        // Retried after a backoff in the real outbox; the fake retries on resumeOutbox.
        job.state = 'queued';
        job.attempts += 1;
      }
      job.error = jobError(err.code, err.message, job.state);
      touch(r);
      changed([r.id]);
      return;
    }
    if (!live()) return;
    if (!isObject(target) || target.clientKey !== job.clientKey) {
      job.abort = undefined;
      job.state = 'failed';
      job.error = jobError(
        'host_misconfigured',
        "The upload target's clientKey doesn't match.",
        'failed',
      );
      touch(r);
      changed([r.id]);
      return;
    }
    job.uploadId = target.uploadId;
    job.artifactId = target.artifactId;
    job.token = target.token;
    job.attempts += 1;
    job.error = undefined;
    // The server has the video already (a resend after a kill): straight to its outcome.
    const settled =
      target.state === 'processing' || target.state === 'delivered' || target.state === 'kept';
    job.state = settled ? 'delivering' : 'uploading';
    touch(r);
    changed([r.id]);
    try {
      if (!settled) {
        for (const part of server.related ?? []) {
          await uploadArtifact({
            endpoint: target.endpoint,
            token: job.token,
            artifactId: newRequestId(),
            filename: part.filename,
            kind: part.kind,
            relatedTo: target.artifactId,
            body: part.fixture,
            fetch: fetchFn,
            signal: abort.signal,
          });
          if (!live()) return;
        }
        await uploadArtifact({
          endpoint: target.endpoint,
          token: job.token,
          artifactId: target.artifactId,
          filename: `${r.id}.mp4`,
          kind: 'video',
          name: displayName(r),
          body: server.fixture,
          fetch: fetchFn,
          signal: abort.signal,
        });
        if (!live()) return;
        job.progress = 1;
        emitEvent('uploadProgress', {
          draftId: r.id,
          uploadId: target.uploadId,
          fraction: 1,
          bytesSent: bytes,
          bytesTotal: bytes,
        });
        job.state = 'delivering';
        touch(r);
        changed([r.id]);
      }
      const outcome = await pollOutcome({
        endpoint: target.endpoint,
        artifactId: target.artifactId,
        token: () => job.token ?? '',
        fetch: fetchFn,
        pollMs: server.pollMs ?? 1000,
        sleep,
        live,
        refresh: async () => {
          const t = (await askHost('refreshUploadToken', {
            uploadId: target.uploadId,
            clientKey: job.clientKey,
            draftId: r.id,
          })) as { token?: unknown };
          if (typeof t?.token === 'string') job.token = t.token;
        },
      });
      if (!outcome || !live()) return;
      retire(r, outcome.state, outcome);
    } catch (e) {
      if (!live()) return;
      job.abort = undefined;
      job.state = 'failed';
      const message = e instanceof Error ? e.message : String(e);
      const refused =
        e instanceof TusError && e.status !== null && e.status >= 400 && e.status < 500;
      job.error = jobError(refused ? 'upload.refused' : 'upload.failed', message, 'failed');
      touch(r);
      changed([r.id]);
    }
  }

  function cancelJob(r: Row): void {
    const job = r.job;
    if (!job) return;
    job.abort?.abort();
    r.job = undefined;
    r.exported = true;
    if (job.uploadId) {
      // Fire and forget: the server's sweep covers a host without the handler.
      askHost('releaseUploadTarget', {
        uploadId: job.uploadId,
        clientKey: job.clientKey,
        reason: 'canceled',
      }).catch(() => {});
    }
  }

  // ── Flows ────────────────────────────────────────────────────────────────────────────────────

  function info(): PulseInfo {
    const base: PulseInfo = {
      sdkVersion: '0.0.0-fake',
      build: '0',
      gitSha: 'fake',
      contract: { major: CONTRACT.major, minor: FACADE_MINOR },
      formatVersion: 2,
      dbSchema: 0,
      entries: ['record', 'edit', 'export'],
      methods: Object.keys(METHODS),
      capabilities: ['upload.pulse', 'upload.file', 'headless'],
      platform: 'ios',
      osVersion: '18.0',
      supported: true,
      namespace: active,
    };
    return { ...base, ...(script.info as Partial<PulseInfo>), namespace: active };
  }

  function nextStep(): FakeStep {
    const s = steps[Math.min(stepIndex, steps.length - 1)];
    stepIndex += 1;
    return s;
  }

  function base(f: Flow, endedOn: FlowResult['endedOn'], stage: FlowResult['stage']) {
    return {
      ...(f.step.extra ?? {}),
      requestId: f.requestId,
      entry: f.entry,
      endedOn,
      stage,
      context: clone(f.context),
      endedAt: now(),
    };
  }

  function screenOf(f: Flow): 'recorder' | 'editor' | 'export' {
    return f.entry === 'record' ? 'recorder' : f.entry === 'edit' ? 'editor' : 'export';
  }

  /** The draft the flow made or holds; a record 'new' makes its take now. */
  function take(f: Flow): Row {
    if (f.draftId) {
      const existing = rows().get(f.draftId);
      if (existing) return existing;
    }
    const r = newRow(f.context, f.step);
    rows().set(r.id, r);
    f.draftId = r.id;
    return r;
  }

  function finish(f: Flow, result: FlowResult): void {
    if (f.ended) return;
    f.ended = true;
    if (f.timer !== undefined) {
      // Closed before the scripted end: nothing else will settle the tracked ending.
      clearTimeout(f.timer);
      f.timer = undefined;
      f.settle();
    }
    if (flow === f) flow = null;
    // Written to the inbox before anything else (AD15), so a lost reply loses nothing.
    inbox.delete(f.requestId);
    inbox.set(f.requestId, clone(result));
    last = clone(result);
    if (f.draftId) changed([f.draftId]);
    if (f.drop) return;
    emitEvent('flowResult', result);
    f.resolve(clone(result));
  }

  async function end(f: Flow): Promise<void> {
    if (f.ended || disposed) return;
    const step = f.step;
    const mode = configured.uploadMode;
    if (step.result === 'discarded') {
      finish(f, {
        ...base(f, screenOf(f), 'none'),
        status: 'canceled',
        reason: 'user',
        ...(f.existing && f.draftId ? { draftId: f.draftId } : {}),
      });
      return;
    }
    if (step.result === 'failed') {
      finish(f, {
        ...base(f, null, 'none'),
        status: 'failed',
        error: {
          code: step.code as PulseErrorCode,
          message: `Scripted failure (${step.code}).`,
          recoverable: isRecoverableCode(step.code),
          callId: f.callId,
          requestId: f.requestId,
          ...(f.existing && f.draftId ? { draftId: f.draftId } : {}),
        },
        ...(f.existing && f.draftId ? { draftId: f.draftId } : {}),
      });
      return;
    }
    const r = take(f);
    // An edit cancels a job that hasn't started sending (pulse-schema.md §3.3).
    if (r.job && !LOCKED.includes(r.job.state)) cancelJob(r);
    // Recorded or edited: a new cut. Export alone sends the draft as it is.
    if (f.entry !== 'export') r.cut = hex(16);
    if (step.result === 'kept') {
      // The take changed and nobody exported it: the export (if any) is stale.
      r.exported = false;
      touch(r);
      finish(f, {
        ...base(f, screenOf(f), f.entry === 'record' ? 'recorded' : 'edited'),
        status: 'closed',
        reason: 'user',
        draftId: r.id,
        draft: summary(r),
      });
      return;
    }
    r.exported = true;
    r.bytes ??= fixtureBytes();
    touch(r);
    if (step.result === 'file' || mode === 'file') {
      finish(f, {
        ...base(f, 'export', 'exported'),
        status: 'completed',
        mode: 'file',
        draftId: r.id,
        export: fileRef(`results/${f.requestId}.mp4`, r.bytes),
        durationMs: r.durationMs,
        project: fileRef(`results/${f.requestId}.project.json`),
        draft: summary(r),
      });
      return;
    }
    // Send (AD23): a confirmed draft keeps its sentAt and skips the confirm; otherwise a type with
    // confirmSend asks the host first and only completes on success.
    let sentAt = now();
    const type = r.context?.uploadType;
    if (r.confirmedAt === undefined && type?.confirmSend) {
      changed([r.id]);
      const ask: ConfirmSendRequest = {
        draftId: r.id,
        draftKey: r.draftKey,
        context: r.context as PulseContext,
        uploadType: type,
        sentAt,
        bytes: r.bytes,
      };
      let answer: ConfirmSendResult;
      try {
        answer = (await askHost('confirmSend', ask)) as unknown as ConfirmSendResult;
      } catch {
        // Failure keeps Pulse open on Export with the draft unsent ("Try again" / "Keep draft").
        if (f.ended) return;
        f.waiting = true;
        changed([r.id]);
        return;
      }
      if (f.ended) return;
      r.confirmedAt = typeof answer?.confirmedAt === 'number' ? answer.confirmedAt : now();
      r.confirmedSentAt = sentAt;
    } else if (r.confirmedAt !== undefined) {
      // Edit → Send on a confirmed draft: no second confirm, the original sentAt.
      sentAt = r.confirmedSentAt ?? sentAt;
    }
    const job = queue(r, sentAt);
    finish(f, {
      ...base(f, 'export', 'exported'),
      status: 'completed',
      mode: 'pulse',
      draftId: r.id,
      sentAt: job.sentAt,
      clientKey: job.clientKey,
      draftKey: r.draftKey,
      ...(r.confirmedAt === undefined ? {} : { confirmedAt: r.confirmedAt }),
      draft: summary(r),
    });
    startUpload(r);
  }

  function open(args: Record<string, Json>, callId: string): Promise<FlowResult> {
    const check = checkOpen(args);
    if (!check.ok) throw new Failure('invalid_options', check.message);
    const requestId = check.requestId ?? newRequestId();
    if (flow && !flow.ended) {
      if (flow.requestId === requestId) return flow.done;
      throw new Failure('busy', 'A flow is already open.', { requestId });
    }
    // Asked again after it ended (a reload re-sending its open): the result it already has.
    const done = inbox.get(requestId);
    if (done) return Promise.resolve(clone(done));
    if (needsAccount() && active === null) {
      throw new Failure('no_account', 'No account is set (setAccount).');
    }
    const entry = check.entry as Flow['entry'];
    let context: PulseContext | null = null;
    let draftId: string | undefined;
    if (entry === 'record') {
      context = clone(args.context) as unknown as PulseContext;
      const d = args.draft;
      if (isObject(d) && typeof d.continue === 'string') {
        const r = row(d.continue);
        assertUnlocked(r);
        draftId = r.id;
      }
    } else {
      const r = row(args.draftId);
      assertUnlocked(r);
      draftId = r.id;
      context = clone(r.context);
    }
    let resolve!: (r: FlowResult) => void;
    const promise = new Promise<FlowResult>((res) => (resolve = res));
    let settle!: () => void;
    const ending = new Promise<void>((res) => (settle = res));
    const step = nextStep();
    const f: Flow = {
      requestId,
      callId,
      entry,
      context,
      draftId,
      existing: draftId !== undefined,
      step,
      drop: dropNext,
      done: promise,
      resolve,
      settle,
      waiting: false,
      ended: false,
    };
    dropNext = false;
    flow = f;
    f.timer = later(step.afterMs ?? script.latencyMs ?? 0, () => {
      f.timer = undefined;
      end(f).then(settle, (e: unknown) => {
        console.error('[pulse-embed/testing] a flow failed to end', e);
        settle();
      });
    });
    void track(ending);
    return promise;
  }

  function close(args: Record<string, Json>): null {
    const f = flow;
    if (!f || f.ended) return null;
    if (f.timer !== undefined) clearTimeout(f.timer);
    const hasTake =
      f.waiting || f.existing || (f.step.result !== 'discarded' && f.step.result !== 'failed');
    if (args.discard === true || !hasTake) {
      if (!f.existing && f.draftId) rows().delete(f.draftId);
      const draftId = f.existing ? f.draftId : undefined;
      finish(f, {
        ...base(f, screenOf(f), 'none'),
        status: 'canceled',
        reason: 'host',
        ...(draftId ? { draftId } : {}),
      });
      return null;
    }
    const r = take(f);
    touch(r);
    finish(f, {
      ...base(f, f.waiting ? 'export' : screenOf(f), r.exported ? 'exported' : 'recorded'),
      status: 'closed',
      reason: 'host',
      draftId: r.id,
      draft: summary(r),
    });
    return null;
  }

  // ── Data API ───────────────────────────────────────────────────────────────────────────────────

  function listDrafts(a: Record<string, Json>): DraftSummary[] {
    const states = Array.isArray(a.states) ? (a.states as string[]) : null;
    return (
      [...rows().values()]
        .map(summary)
        .filter((s) => (states ? states.includes(s.state) : s.state !== 'sent'))
        .filter((s) => typeof a.contextKey !== 'string' || s.context?.key === a.contextKey)
        .filter(
          (s) =>
            typeof a.contextKeyPrefix !== 'string' ||
            (s.context?.key ?? '').startsWith(a.contextKeyPrefix),
        )
        .filter((s) => typeof a.contextKind !== 'string' || s.context?.kind === a.contextKind)
        // catalog-filter.ts `catalogOrder`: the newest change first, equal times by id.
        .sort((x, y) => y.updatedAt - x.updatedAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    );
  }

  function countDrafts(a: Record<string, Json>): Record<string, number> {
    const by = a.by === 'contextKind' ? 'kind' : 'key';
    const states = Array.isArray(a.states) ? (a.states as string[]) : null;
    const out: Record<string, number> = {};
    for (const s of [...rows().values()].map(summary)) {
      if (!s.context) continue;
      if (a.attentionOnly === true) {
        const attention =
          s.state === 'failed' ||
          (s.state === 'sent' && s.sent?.outcome === 'kept' && !s.sent.dismissed);
        if (!attention) continue;
      }
      if (states ? !states.includes(s.state) : a.attentionOnly !== true && s.state === 'sent') {
        continue;
      }
      const k = s.context[by];
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }

  function usageOf(ns: string) {
    const all = [...(spaces.get(ns)?.rows.values() ?? [])].map(summary);
    const unsent = all.filter((s) => s.state !== 'sent');
    return {
      namespace: ns,
      bytes: unsent.reduce((n, s) => n + (s.bytes ?? 0), 0),
      drafts: unsent.length,
      unsent: unsent.length,
      uploading: unsent.filter((s) =>
        ['preparing', 'queued', 'waiting_network', 'uploading', 'delivering'].includes(s.state),
      ).length,
      failed: unsent.filter((s) => s.state === 'failed').length,
      receipts: all.length - unsent.length,
    };
  }

  function busyFlow(): void {
    if (flow && !flow.ended) throw new Failure('busy', 'A flow is open.');
  }

  async function handle(method: string, a: Record<string, Json>, callId: string): Promise<unknown> {
    switch (method) {
      case 'info':
        return info();
      case 'configure': {
        const problem = checkConfigure(a);
        if (problem) throw new Failure('invalid_options', problem);
        configured = {
          uploadMode: a.uploadMode === 'file' ? 'file' : 'pulse',
          hostId: typeof a.hostId === 'string' ? a.hostId : DEFAULT_HOST_ID,
        };
        rekeySeeds(configured.hostId);
        return null;
      }
      case 'prewarm':
        return null;
      case 'open':
        return open(a, callId);
      case 'close':
        return close(a);
      case 'isOpen':
        return flow !== null && !flow.ended;
      case 'pendingResults':
        return [...inbox.values()];
      case 'acknowledge':
        if (!isPlainName(a.requestId))
          throw new Failure('invalid_options', 'requestId is required.');
        inbox.delete(a.requestId);
        return null;
      case 'logFile':
        return fileRef('logs/pulse.log');
      case 'setAccount': {
        busyFlow();
        if (typeof a.serverOrigin !== 'string' || typeof a.userId !== 'string') {
          active = null;
          return { namespace: null };
        }
        const account: PulseAccount = {
          serverOrigin: a.serverOrigin,
          userId: a.userId,
          ...(typeof a.label === 'string' ? { label: a.label } : {}),
        };
        const ns = namespaceFor(account, configured.hostId);
        const s = space(ns, account, configured.hostId);
        s.lastUsedAt = now();
        bindSeeds(ns, s);
        active = ns;
        return { namespace: ns };
      }
      case 'listDrafts':
        return listDrafts(a);
      case 'getDraft': {
        const r = rows().get(String(a.id));
        return r ? summary(r) : null;
      }
      case 'countDrafts':
        return countDrafts(a);
      case 'renameDraft': {
        const r = draftRow(a.id);
        checkLock(r);
        // The name rides the upload as the video's title: a queued Send goes back to a draft.
        cancelJob(r);
        r.name = String(a.name).trim() || null;
        touch(r);
        changed([r.id]);
        return null;
      }
      case 'deleteDraft': {
        const r = draftRow(a.id);
        checkLock(r);
        // A clock-bound draft goes too: the host cancels its intent (O13).
        cancelJob(r);
        rows().delete(r.id);
        changed([r.id]);
        return null;
      }
      case 'setDraftContext': {
        // Checked first: a context Pulse would refuse never cancels a Send.
        const problem = contextProblem(a.context);
        if (problem) throw new Failure('invalid_options', problem);
        const r = draftRow(a.id);
        checkLock(r);
        if (r.confirmedAt !== undefined) {
          // Clock-bound: the host already clocked with this video (AD23).
          throw new Failure('draft.locked', 'The draft is clock-bound.', {
            draftId: r.id,
            reason: 'clock_bound',
          });
        }
        cancelJob(r);
        r.context = clone(a.context) as unknown as PulseContext;
        touch(r);
        changed([r.id]);
        return null;
      }
      case 'upload': {
        const r = draftRow(a.id);
        if (configured.uploadMode !== 'pulse') {
          throw new Failure(
            'host_misconfigured',
            "upload sends through the host's services, which uploadMode 'file' has none of.",
            { draftId: r.id },
          );
        }
        return hostSend(r);
      }
      case 'cancelUpload': {
        const r = draftRow(a.id);
        // An upload can be cancelled while its bytes go up; not while it prepares or delivers.
        checkLock(r, ['preparing', 'delivering']);
        if (r.job) {
          cancelJob(r);
          touch(r);
          changed([r.id]);
        }
        return null;
      }
      case 'retireDraft': {
        const r = row(a.id);
        if (r.receipt) return null; // retired already
        if (configured.uploadMode === 'file') {
          checkLock(r);
          retire(r, 'done');
          return null;
        }
        // 'pulse' mode: only the status route retires a draft (server mode polls it); the call is
        // a hint to ask again, and never retires by itself.
        checkLock(r, []);
        return null;
      }
      case 'dismissReceipt': {
        const r = rows().get(String(a.id));
        if (!r?.receipt) {
          throw new Failure('not_found', `No receipt ${String(a.id)}.`, { draftId: String(a.id) });
        }
        // Dismissing again keeps the first time.
        if (!r.receipt.dismissed) {
          r.receipt.dismissed = true;
          touch(r);
        }
        changed([r.id]);
        return null;
      }
      case 'resumeOutbox': {
        const ids: string[] = [];
        for (const r of rows().values()) {
          if (r.job?.state === 'needs_credentials') {
            // The last error stays until the host answers (outbox.ts 'resume').
            r.job.state = 'queued';
            ids.push(r.id);
          }
          if (r.job?.state === 'queued') startUpload(r);
        }
        changed(ids);
        return null;
      }
      case 'usage':
        if (active === null) throw new Failure('no_account', 'No account is set (setAccount).');
        return usageOf(active);
      case 'listNamespaces':
        return [...spaces.entries()].map(([ns, s]) => {
          const u = usageOf(ns);
          return {
            namespace: ns,
            hostId: s.hostId,
            serverOrigin: s.account.serverOrigin,
            ...(s.account.label ? { label: s.account.label } : {}),
            bytes: u.bytes,
            unsent: u.unsent,
            lastUsedAt: s.lastUsedAt,
            active: ns === active,
          };
        });
      case 'purge': {
        busyFlow();
        const ns = typeof a.namespace === 'string' ? a.namespace : active;
        if (ns === null) throw new Failure('no_account', 'No account is set (setAccount).');
        const s = spaces.get(ns);
        if (!s) return null;
        const ids = [...s.rows.keys()];
        for (const r of s.rows.values()) r.job?.abort?.abort();
        s.rows.clear();
        if (ns !== active) spaces.delete(ns);
        if (ns === active) changed(ids);
        return null;
      }
      case 'respondHostRequest':
        return respondHostRequest(a);
      default:
        throw new Failure('method.unsupported', `The fake doesn't answer ${method}.`);
    }
  }

  function reply(r: BridgeReply): Promise<BridgeReply> {
    const ms = script.latencyMs ?? 0;
    return ms > 0 ? new Promise((res) => later(ms, () => res(r))) : Promise.resolve(r);
  }

  function failure(callId: string, e: Failure): BridgeReply {
    return buildReply({
      ok: false,
      callId,
      error: { ...e.extra, code: e.code, message: e.message },
    });
  }

  const adapter: PulseAdapter = {
    kind: 'fake',
    present: () => Promise.resolve(true),
    async call(method, args, callId) {
      calls.push({ method, args: clone(args) ?? null });
      const i = info();
      const routed = routeRequest(buildRequest(method, args, callId), {
        methods: i.methods,
        supported: i.supported,
      });
      if (routed.route === 'reply') return reply(routed.reply);
      try {
        const out = handle(routed.method, routed.args, callId);
        if (routed.method === 'open') {
          // The reply waits for the flow's end (no timeout); a dropped result never answers.
          const result = await out;
          return buildReply({ ok: true, callId, result: clone(result) as Json });
        }
        const result = await out;
        return reply(buildReply({ ok: true, callId, result: (clone(result) ?? null) as Json }));
      } catch (e) {
        if (e instanceof Failure) return reply(failure(callId, e));
        throw e;
      }
    },
    subscribe(cb) {
      subscribers.add(cb);
      if (retained.length > 0) {
        // Delivered after subscribe returns, as the plugins do for retained events.
        void Promise.resolve().then(() => {
          for (const e of retained.splice(0)) deliver(e);
        });
      }
      return () => {
        subscribers.delete(cb);
      };
    },
    toWebUrl: script.toWebUrl ?? ((path) => `fakepulse://local${path}`),
  };

  // Made on first use, so a page that installs only `adapter` (window.__PULSE_ADAPTER__) has no
  // second subscriber, and events retain at the adapter as they do in the plugins.
  let client: PulseClient | null = null;

  return {
    adapter,
    get client() {
      client ??= createPulseClient({ adapter });
      return client;
    },
    calls,
    hostRequests,
    emit(name, payload) {
      emitEvent(name, payload);
    },
    setOnline(next) {
      if (online === next) return;
      online = next;
      if (active === null) return;
      const ids: string[] = [];
      for (const r of rows().values()) {
        if (r.job?.state !== 'queued') continue;
        ids.push(r.id);
        if (online) startUpload(r);
      }
      changed(ids);
    },
    lastResult: () => clone(last),
    reload() {
      // The old page is gone: its listeners with it. Events now retain for the new page.
      subscribers.clear();
      client = createPulseClient({ adapter });
      return client;
    },
    dropNextResult() {
      dropNext = true;
    },
    drafts: () => (active === null ? [] : [...rows().values()].map(summary).map((s) => clone(s))),
    transition(draftId, e) {
      const r = row(draftId);
      const job = r.job;
      if (!job) throw new Error(`Draft ${draftId} has no upload job.`);
      switch (e.type) {
        case 'uploading':
          job.state = 'uploading';
          job.uploadId ??= `u-${hex(12)}`;
          job.artifactId ??= newRequestId();
          if (e.progress !== undefined) {
            job.progress = e.progress;
            const total = r.bytes ?? DEFAULT_BYTES;
            emitEvent('uploadProgress', {
              draftId: r.id,
              uploadId: job.uploadId,
              fraction: e.progress,
              bytesSent: Math.round(total * e.progress),
              bytesTotal: total,
            });
          }
          break;
        case 'delivering':
          job.state = 'delivering';
          break;
        case 'needs_credentials':
          job.state = 'needs_credentials';
          job.error = jobError(
            'credentials.expired',
            'The host gave no upload target.',
            'needs_credentials',
          );
          break;
        case 'failed':
          job.state = 'failed';
          job.error = jobError(
            e.code ?? 'upload.failed',
            e.message ?? 'Scripted failure.',
            'failed',
          );
          break;
        case 'delivered':
          retire(r, e.outcome, e);
          return;
      }
      touch(r);
      changed([r.id]);
    },
    async idle() {
      while (work.size > 0) await Promise.allSettled([...work]);
    },
    dispose() {
      disposed = true;
      for (const wake of [...wakers]) wake();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const s of spaces.values()) for (const r of s.rows.values()) r.job?.abort?.abort();
      if (flow?.timer !== undefined) {
        clearTimeout(flow.timer);
        flow.timer = undefined;
        flow.settle();
      }
    },
  };
}
