/**
 * @mieweb/pulse-embed — host contract v1 (types). The compiled form of
 * `.devrun/plans/embed/build/contract/pulse-embed.d.ts` (2026-11-17), reconciled with PLAN-final §8.
 * Every amendment to that file carries a `// PLAN-final §8 / <decision>` comment.
 *
 * VERSIONING (AD18), binding for every later change:
 *  1. `contract.major` changes only for a breaking change. A client refuses a facade with another
 *     major (`contract.unsupported`); v1 is major 1.
 *  2. `contract.minor` counts additions: PR1 ships minor 0 (flows, info, inbox, close),
 *     PR2 ships minor 1 (data API, accounts, outbox, host services). Each method's minor is in
 *     the MethodName table below; a host checks `info().methods.includes(name)`, never the minor.
 *  3. Unknown fields are IGNORED on both sides: a request field the facade doesn't know is
 *     dropped (never `invalid_options`), and a result field the client doesn't know is passed
 *     through untouched. A missing required field, or a wrong type, is `invalid_options`.
 *  4. Error codes, states, entry names, event names and fields are append-only. Never rename,
 *     never reuse a removed name. A client must treat an unknown error code as `unknown`, an
 *     unknown DraftState as `draft`, and an unknown event as ignorable.
 *  5. Every value crossing the boundary is JSON: no Date, no undefined-as-value, no functions.
 *     Times are integer milliseconds since the epoch (UTC). Ids are strings.
 */

// ─── Versions ────────────────────────────────────────────────────────────────────────────────

/** Every method a facade may list in `info().methods`, with the minor that added it. */
export type MethodName =
  // minor 0 (PR1)
  | 'info'
  | 'configure'
  | 'prewarm'
  | 'open'
  | 'close'
  | 'isOpen'
  | 'pendingResults'
  | 'acknowledge'
  | 'logFile'
  // minor 1 (PR2)
  | 'setAccount'
  | 'listDrafts'
  | 'getDraft'
  | 'countDrafts'
  | 'renameDraft'
  | 'deleteDraft'
  | 'setDraftContext'
  | 'upload'
  | 'cancelUpload'
  | 'retireDraft'
  | 'dismissReceipt'
  | 'resumeOutbox'
  | 'usage'
  | 'listNamespaces'
  | 'purge'
  | 'respondHostRequest';

export type Platform = 'ios' | 'android';
export type EntryName = 'record' | 'edit' | 'export';

/**
 * Feature flags a build reports. `headless`: data writes and uploads run with nothing presented
 * (spike S3 passed); without it a write presents the brief "Preparing…" screen (AD5).
 */
export type Capability =
  | 'upload.pulse' // Pulse uploads to a host-supplied PulseVault target (AD6)
  | 'upload.file' // Export can hand the MP4 back instead (uploadMode 'file')
  | 'upload.background' // uploads continue after Pulse closes / the app backgrounds (E5)
  | 'headless'
  | 'captions' // on-device captions, sent with the video (F5)
  | 'share' // the system share sheet on Export (Q6)
  | 'saveToPhotos'; // Save to Photos on Export (Q6)

export interface ContractVersion {
  readonly major: 1;
  readonly minor: number;
}

export interface PulseInfo {
  /** PulseKit's version, the same as the Pulse app version it was built from (lockstep, AD18). */
  sdkVersion: string;
  build: string;
  gitSha: string;
  contract: { major: 1; minor: number };
  /** `.pulse` project document version (src/db/project.ts PROJECT_VERSION, 2 today). */
  formatVersion: number;
  /** Newest drizzle migration this build ships (APP_SCHEMA_VERSION). */
  dbSchema: number;
  entries: EntryName[];
  /** Methods this facade answers. Strings, so a newer facade's names pass through. */
  methods: string[];
  capabilities: string[];
  platform: Platform;
  osVersion: string;
  /**
   * False below iOS 16.4 / Android API 24, and on iPad until X7. A host shows its link/QR
   * fallback when false; every call except `info` then rejects `unsupported`.
   */
  supported: boolean;
  unsupportedReason?: 'os' | 'ipad' | 'device';
  /** The active account's namespace, or null before `setAccount` (PR2). */
  namespace: string | null;
}

// ─── Context and upload types ────────────────────────────────────────────────────────────────

/** Any JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * What a host-defined upload type asks of Pulse. v1 is a thin map over TimeHuddle's
 * DESTINATIONS (huddle-server.md §2); Pulse treats `id` as opaque and only reads the fields
 * below. `meta` is the X1 extension point (JSON Schema metadata), unused in v1.
 */
export interface UploadTypeSpec {
  /** e.g. 'ticket.video', 'clock.session', 'clock.wrapup', 'clock.plan', 'huddle.post', 'library.video'. */
  id: string;
  version: number;
  /** Banner kind label: "Ticket", "Clock session", "Wrap-up", "Plan", "Post", "Library". */
  title?: string;
  /** Export's primary action. Default "Send to <context.label>". e.g. "Clock out & send". */
  sendLabel?: string;
  /** One line shown on the recorder banner, e.g. "Say what you finished today". */
  prompt?: string;
  limits?: { maxDurationMs?: number; minClips?: number };
  /** Export blocks Send until the draft has a name. */
  requireName?: boolean;
  // PLAN-final §8 / AD23
  /** The primary action is disabled offline ("Needs a connection") and re-checked at the tap. */
  requireOnline?: boolean;
  // PLAN-final §8 / AD23
  /** At Send, Pulse calls `HostServices.confirmSend` and waits for it before it closes. */
  confirmSend?: boolean;
  // PLAN-final §8 / F8
  /** The host server's size cap, for the pre-Send warning. Not a recording limit. */
  maxBytes?: number;
  meta?: Json;
}

/**
 * The host place a draft is for (AD11). Required to record (Q3: no global camera).
 * `key` is the grouping key and the server's `targetKey` (huddle-server.md §2), built by the
 * host's place module as `${kind}:${id.toLowerCase()}`: 1–128 chars of [a-z0-9._:-] (see
 * `contextKey`). Pulse stores the whole object (≤ 8 KB as JSON, else `invalid_options`) and
 * hands it back unchanged in DraftSummary, FlowResult and getUploadTarget.
 */
export interface PulseContext {
  key: string;
  /** The key's prefix, e.g. 'ticket', 'clock', 'clock-plan', 'huddle', 'library'. */
  kind: string;
  /** The key's suffix as the host spells it (case kept). */
  id: string;
  /** What the place is called, ≤ 120 chars: "Fix login", "Mon 9:02 session", "Platform". */
  label: string;
  uploadType?: UploadTypeSpec;
  /**
   * Opaque host data, returned verbatim to `getUploadTarget`. TimeHuddle puts the server
   * target here: `{ type, target }` (huddle-server.md §2), e.g.
   * `{ type: 'huddle.post', target: { kind: 'huddle', teamId, conversationId } }`.
   */
  data?: Json;
}

// ─── Files ───────────────────────────────────────────────────────────────────────────────────

/**
 * A file inside the account's namespace. `path` is an absolute native path; `webUrl` is what
 * the host's WebView can load (Capacitor.convertFileSrc / Cordova's local server), filled by
 * the plugin adapter, with `?v=<updatedAt>` for cache busting. Valid until the next
 * `draftsChanged` naming the draft; never write to it.
 */
export interface FileRef {
  /** Relative to the namespace's documents root, '/'-separated, e.g. 'drafts/<id>/export.mp4'. */
  rel: string;
  path: string;
  webUrl: string;
  bytes?: number;
}

// ─── Theme, policy, configuration ────────────────────────────────────────────────────────────

/** F6 / AD26: Pulse's look with the host's accent. Colours are CSS hex '#rrggbb'. */
export interface ThemeBridge {
  appearance?: 'light' | 'dark' | 'system';
  accent?: string;
  destructive?: string;
  /** Button corner radius in points. */
  buttonRadius?: number;
}

export interface HostPolicy {
  /** Q6 keeps both; a host may still turn either off. Defaults true. */
  allowShare?: boolean;
  allowSaveToPhotos?: boolean;
  /** One-time tips inside Pulse. Default true. Welcome/onboarding never shows in the embed. */
  tips?: boolean;
  /** 'host': `log` events in debug builds and `logFile()`; 'off': neither. Default 'host'. */
  logs?: 'host' | 'off';
  /** Uploads wait for Wi-Fi. Default false. */
  wifiOnlyUploads?: boolean;
}

/** PLAN-final §8 / O6: when the on-device captions model downloads, and whether takes get captions. */
export interface CaptionsOptions {
  /** 'wifi' (default): download automatically on Wi-Fi the first time Pulse opens; ask on cellular. */
  autoDownload?: 'wifi' | 'never';
  /** Default true: generate captions for every take; the person can turn them off per take. */
  autoGenerate?: boolean;
}

export interface ConfigureOptions {
  /** Namespace prefix (AD12): [a-z0-9.-], ≤ 40. Default: the sanitised bundle id. */
  hostId?: string;
  /** Replaces "Pulse" only where it means the app: "Back to TimeHuddle" (Q19 keeps "Pulse"). */
  hostName?: string;
  /** 'pulse' (default): Pulse uploads through HostServices. 'file': Export returns the MP4. */
  uploadMode?: 'pulse' | 'file';
  policy?: HostPolicy;
  theme?: ThemeBridge;
  /** C8: where the captions models download from. Default Pulse's built-in source. */
  models?: { baseUrl: string };
  // PLAN-final §8 / O6
  captions?: CaptionsOptions;
}

/** PR2. The signed-in person; the namespace is derived from it natively (AD12). */
export interface PulseAccount {
  /** Origin of the host's server, e.g. 'https://timehuddle.example.org' (scheme + host [+ port]). */
  serverOrigin: string;
  userId: string;
  /** Optional display text for `listNamespaces` (shared devices, Q4). Never hashed, never required. */
  label?: string;
}

export interface AccountState {
  /** `<hostId>-<16 hex>`, or null after `setAccount(null)`. */
  namespace: string | null;
}

// ─── Flows ───────────────────────────────────────────────────────────────────────────────────

export interface OpenBase {
  /** Idempotency key. Same id while that flow is open → the same pending promise. Default: a UUID. */
  requestId?: string;
  /** Per-open override of `configure({theme})`. */
  theme?: ThemeBridge;
}

/**
 * Open the recorder for `context`. `draft`: 'new' (default) always starts a new draft; with
 * `{ continue: draftId }` the recorder opens on that unsent draft (the host's
 * "Continue 'Fix login' (0:42) / New video" sheet). A sent or locked draft → `draft.locked`.
 */
export interface RecordRequest extends OpenBase {
  entry: 'record';
  context: PulseContext;
  draft?: 'new' | { continue: string };
}

/** Open the editor on a draft (and optionally scroll to a clip). Locked → `draft.locked`. */
export interface EditRequest extends OpenBase {
  entry: 'edit';
  draftId: string;
  clipId?: string;
}

/** Open Export on a draft (merges if the export is stale). */
export interface ExportRequest extends OpenBase {
  entry: 'export';
  draftId: string;
}

export type OpenRequest = RecordRequest | EditRequest | ExportRequest;

/** PLAN-final §8 / Q4 (TH-9): `close`'s options. */
export interface CloseOptions {
  reason?: 'host';
  // PLAN-final §8 / Q4, O7
  /** Shared phone: the open take is deleted instead of kept (the flow ends `canceled`). */
  discard?: boolean;
}

export type FlowScreen = 'recorder' | 'editor' | 'export';
/** How far the draft got in this flow: no clip, recorded, edited, exported (merge current). */
export type FlowStage = 'none' | 'recorded' | 'edited' | 'exported';

export interface FlowResultBase {
  requestId: string;
  entry: EntryName;
  /** The screen the flow ended on; null when it never mounted (a failure before the first frame). */
  endedOn: FlowScreen | null;
  stage: FlowStage;
  /** The context the flow ran for (the draft's, for edit/export). */
  context: PulseContext | null;
  endedAt: number;
}

/**
 * Send was tapped (uploadMode 'pulse'). The job is persisted as `preparing`/`queued` before
 * this result is written. `sentAt` is the device time of the tap: the host clocks in/out with
 * it (Q1, AD23) and the server files the video into the conversation current then (H4).
 */
export interface CompletedSent extends FlowResultBase {
  status: 'completed';
  mode: 'pulse';
  draftId: string;
  sentAt: number;
  /** The outbox job's key: `<installationId>:<draftId>:<16 hex of sha256(mergedSignature)>`. */
  clientKey: string;
  /** `<installationId>:<draftId>`: the server cancels an older clientKey with the same draftKey. */
  draftKey: string;
  // PLAN-final §8 / AD23
  /** When the host's `confirmSend` succeeded; set only for types with `confirmSend`. */
  confirmedAt?: number;
  draft?: DraftSummary;
}

/**
 * "Use this video" (uploadMode 'file'). `export` is a copy under `results/` the host owns until
 * `acknowledge(requestId)`; the draft stays until `retireDraft`.
 */
export interface CompletedFile extends FlowResultBase {
  status: 'completed';
  mode: 'file';
  draftId: string;
  export: FileRef;
  durationMs: number;
  /** The draft's `.pulse` v2 project document, next to the export (M1 behaviour, kept). */
  project?: FileRef;
  draft?: DraftSummary;
}

/** X → Keep draft (the take is kept), or the host closed the flow (`reason: 'host'`). */
export interface Closed extends FlowResultBase {
  status: 'closed';
  reason: 'user' | 'host' | 'interrupted';
  draftId: string;
  draft?: DraftSummary;
}

/** X → Discard video, or closed with no clip (no draft is created). */
export interface Canceled extends FlowResultBase {
  status: 'canceled';
  reason: 'user' | 'host' | 'interrupted';
  /** Set only when an existing draft was opened (edit/export, record continue) and left unchanged. */
  draftId?: string;
}

export interface Failed extends FlowResultBase {
  status: 'failed';
  error: PulseErrorInfo;
  /** The draft survives a failure whenever it had a clip. */
  draftId?: string;
}

export type FlowResult = CompletedSent | CompletedFile | Closed | Canceled | Failed;

// ─── Drafts (PR2) ────────────────────────────────────────────────────────────────────────────

/**
 * One state per row (PLAN §5.2; persisted states in pulse-schema.md §3). Derived:
 *   draft            no job, export missing or stale
 *   ready            no job, export current
 *   preparing        job 'preparing' (merging before send)
 *   queued           job 'queued' while online
 *   waiting_network  job 'queued' while offline (or Wi-Fi-only and on cellular)
 *   uploading        job 'uploading'
 *   delivering       job 'delivering' (bytes landed; waiting for the server's outcome)
 *   needs_credentials job 'needs_credentials' (token expired and the host didn't answer)
 *   failed           job 'failed'
 *   sent             an upload receipt (draft retired; 7 days, Q5; no media)
 */
export type DraftState =
  | 'draft'
  | 'ready'
  | 'preparing'
  | 'queued'
  | 'waiting_network'
  | 'uploading'
  | 'delivering'
  | 'needs_credentials'
  | 'failed'
  | 'sent';

/** States in which edit/delete/setDraftContext reject `draft.locked` (PLAN §6.1 lock rule). */
export type LockedState = 'preparing' | 'uploading' | 'delivering' | 'sent';

export interface DraftUpload {
  clientKey: string;
  uploadId?: string;
  artifactId?: string;
  /** 0–1 over the video bytes; absent before the first byte. */
  progress?: number;
  attempts: number;
  nextAttemptAt?: number;
  sentAt: number;
  error?: PulseErrorInfo;
}

export interface DraftReceipt {
  outcome: 'done' | 'kept';
  /** Server's note for 'done' ("Attached to ticket …"), its reason for 'kept'. */
  note?: string;
  reason?: string;
  uploadId: string;
  artifactId: string;
  sentAt: number;
  /** When the outcome was seen. */
  at: number;
  expiresAt: number;
  dismissed: boolean;
}

export interface DraftSummary {
  id: string;
  // PLAN-final §8 / AD32
  /** `<installationId>:<draftId>`: one video's stable identity; survives Edit and Move to…. */
  draftKey: string;
  /** The draft's display name (draftDisplayName), never empty. */
  name: string;
  /** Null only for a draft made before PR2 or imported without one. */
  context: PulseContext | null;
  state: DraftState;
  clipCount: number;
  durationMs: number;
  // PLAN-final §8 / F8
  /** The current export's size, when there is one. */
  bytes?: number;
  // PLAN-final §8 / AD29
  /** The draft has captions that will upload with the video. */
  hasCaptions: boolean;
  // PLAN-final §8 / AD23
  /** When the host's `confirmSend` succeeded for this draft (clock-bound from then on). */
  confirmedAt?: number;
  poster: FileRef | null;
  /** The current merged export, when `state` is 'ready' or later (not on receipts). */
  export?: FileRef;
  upload?: DraftUpload;
  sent?: DraftReceipt;
  createdVia: 'app' | 'host';
  createdAt: number;
  updatedAt: number;
}

export interface DraftFilter {
  contextKey?: string;
  /** e.g. 'clock:' matches every clock session; 'ticket:' every ticket. */
  contextKeyPrefix?: string;
  contextKind?: string;
  /** Default: every state except 'sent'. Pass ['sent'] (or include it) for receipts. */
  states?: DraftState[];
}

export interface CountOptions {
  by: 'contextKey' | 'contextKind';
  /** Only rows that need the person: 'failed', and 'sent' with outcome 'kept' not dismissed. */
  attentionOnly?: boolean;
  states?: DraftState[];
}

export interface Usage {
  namespace: string;
  bytes: number;
  drafts: number;
  /** Drafts not yet sent: every state except 'sent'. The kill switch keeps Pulse reachable while > 0 (AD25). */
  unsent: number;
  uploading: number;
  failed: number;
  receipts: number;
}

export interface NamespaceInfo {
  namespace: string;
  hostId: string;
  serverOrigin: string;
  label?: string;
  bytes: number;
  unsent: number;
  lastUsedAt: number;
  active: boolean;
}

// ─── Host services (PR2, uploadMode 'pulse' only) ────────────────────────────────────────────

/**
 * Pulse asks for this when a job reaches `queued` (Send, a retry, a launch-rule resume) and
 * again with `renewArtifact: true` when PulseVault answers 404 for the artifact (PLAN §6.3
 * step 4). The host calls `pulseUploads.begin` (huddle-server.md §5.1).
 */
export interface UploadTargetRequest {
  draftId: string;
  clientKey: string;
  draftKey: string;
  context: PulseContext;
  /** The draft's display name, sent as the video's name. */
  name: string;
  durationMs: number;
  /** The export's size. */
  bytes: number;
  sentAt: number;
  /** 1 on the first ask for this clientKey. */
  attempt: number;
  renewArtifact: boolean;
}

/** `pulseUploads.begin`'s answer, as Pulse needs it. */
export interface UploadTarget {
  uploadId: string;
  /** PulseVault base URL, e.g. 'https://host/pulsevault' (no trailing slash). */
  endpoint: string;
  artifactId: string;
  /** Capability token for `artifactId` and its related artifacts. Memory only (AD7). */
  token: string;
  expiresAt: number;
  /** Echo of the request's clientKey; Pulse refuses a mismatch as `host_misconfigured`. */
  clientKey: string;
  /**
   * Set when the server already has an outcome for this clientKey (a resend after a kill):
   * Pulse goes straight to delivering → retire.
   */
  state?: 'reserved' | 'uploading' | 'processing' | 'delivered' | 'kept';
}

export interface TokenRequest {
  uploadId: string;
  clientKey: string;
  draftId: string;
}

export interface TokenResult {
  token: string;
  expiresAt: number;
}

export interface ReleaseRequest {
  uploadId: string;
  clientKey: string;
  reason: 'canceled' | 'edited' | 'deleted';
}

/**
 * PLAN-final §8 / AD23. Pulse asks for this at Send, for a type with `confirmSend`, after any
 * merge and before it queues the upload or closes. TimeHuddle runs `clock.stopWithVideo` /
 * `clock.startWithPlan` with `at = sentAt` in it. Idempotent per `draftKey` on the host's side.
 */
export interface ConfirmSendRequest {
  draftId: string;
  draftKey: string;
  context: PulseContext;
  uploadType: UploadTypeSpec;
  sentAt: number;
  /** The export's size. */
  bytes: number;
}

/** PLAN-final §8 / AD23. */
export interface ConfirmSendResult {
  confirmedAt: number;
}

/**
 * A host rejects a service call with one of these codes; anything else counts as
 * `host.unavailable` (retried with backoff).
 *   destination.gone  → job 'failed' (Move to… / Delete); the server refused the target
 *   upload.refused    → job 'failed' (permanent, e.g. a 4xx from begin)
 *   upload.too_large  → job 'failed' (the export is over the server's cap)
 *   no_account        → job 'needs_credentials' (signed out)
 *   host.unavailable  → job 'needs_credentials' after the 20 s timeout, else retry
 */
export interface HostServiceError {
  code:
    | 'destination.gone'
    | 'upload.refused'
    | 'no_account'
    | 'host.unavailable'
    // PLAN-final §8 / F8
    | 'upload.too_large';
  message: string;
}

export interface HostServices {
  getUploadTarget(r: UploadTargetRequest): Promise<UploadTarget>;
  refreshUploadToken(r: TokenRequest): Promise<TokenResult>;
  /** Optional: tell the server a job was cancelled (Cancel sending, Edit, Delete). The server's 24 h sweep covers a host without it. */
  releaseUploadTarget?(r: ReleaseRequest): Promise<void>;
  // PLAN-final §8 / AD23
  /** Required when an upload type sets `confirmSend`; a missing handler fails Send as `host_misconfigured`. */
  confirmSend?(r: ConfirmSendRequest): Promise<ConfirmSendResult>;
}

/** What each `hostRequest` method carries and expects back (native-bridge.md §5). */
export interface HostRequestMap {
  getUploadTarget: { args: UploadTargetRequest; result: UploadTarget };
  refreshUploadToken: { args: TokenRequest; result: TokenResult };
  releaseUploadTarget: { args: ReleaseRequest; result: null };
  // PLAN-final §8 / AD23
  confirmSend: { args: ConfirmSendRequest; result: ConfirmSendResult };
}

export type HostRequestMethod = keyof HostRequestMap;

/** The payload of a `hostRequest` event (facade → client). */
export type HostRequest = {
  [M in HostRequestMethod]: {
    hostCallId: string;
    method: M;
    args: HostRequestMap[M]['args'];
    /** Epoch ms after which the facade drops the request (20 s). */
    deadline: number;
  };
}[HostRequestMethod];

/**
 * `respondHostRequest`'s args (client → facade). `result` may be left out when the method's
 * result is `null` (releaseUploadTarget); a reply carries a result or an error, never both.
 */
export type HostResponse =
  | { hostCallId: string; result?: Json; error?: never }
  | { hostCallId: string; error: HostServiceError; result?: never };

// ─── Errors ──────────────────────────────────────────────────────────────────────────────────

/** A call rejects with a PulseError whose code is one of these. */
export type CallErrorCode =
  | 'unavailable' // no plugin / not a native app
  | 'unsupported' // info().supported is false
  | 'contract.unsupported' // facade major ≠ client major
  | 'method.unsupported' // the facade doesn't list this method (older PulseKit)
  | 'busy' // a flow is open, or the host is presenting something (open/setAccount/purge)
  | 'invalid_options'
  | 'not_found' // no such draft (or it was retired)
  | 'draft.locked' // LockedState, or the draft is open in the current flow
  | 'host.unavailable' // a host service didn't answer in 20 s
  | 'restart_required' // setAccount for another account after the runtime booted (v1, AD12)
  | 'host_misconfigured' // e.g. UploadTarget.clientKey mismatch, missing HostServices in 'pulse' mode
  | 'no_account' // a data call before setAccount
  | 'timeout' // Pulse's runtime didn't answer a forwarded call in time
  | 'storage.full'
  | 'storage.newer_schema'
  | 'storage.damaged'
  | 'unknown'
  // PLAN-final §8 / AD34
  | 'runtime.paused'; // the host's server paused PulseKit's runtime (kill switch)

/** A flow resolves `failed` with one of these; job errors (DraftUpload.error) use them too. */
export type FlowErrorCode =
  | 'permission.camera'
  | 'permission.microphone'
  | 'storage.full'
  | 'storage.newer_schema' // the library was written by a newer PulseKit (opens read-only)
  | 'storage.damaged'
  | 'export.failed'
  | 'upload.failed' // retryable network/server failure that exhausted its attempts
  | 'upload.refused'
  | 'destination.gone'
  | 'credentials.expired'
  | 'runtime.error' // a JS error inside Pulse; the host survives (B3 error isolation)
  | 'unknown'
  // PLAN-final §8 / F8
  | 'upload.too_large'; // the export is over UploadTypeSpec.maxBytes or the server's cap

export type PulseErrorCode = CallErrorCode | FlowErrorCode;

export interface PulseErrorInfo {
  code: PulseErrorCode;
  /** For logs and support, in English. Hosts show their own copy keyed by `code`. */
  message: string;
  /** True when the same call may succeed later without a change by the person. */
  recoverable: boolean;
  /** Correlates with native and JS log lines (every call carries one). */
  callId: string;
  requestId?: string;
  draftId?: string;
  uploadId?: string;
  // PLAN-final §8 / AD23
  /** A finer reason inside `code`, e.g. 'clock_bound' on `draft.locked` from setDraftContext. */
  reason?: string;
  details?: Json;
}

export interface PulseError extends Error, PulseErrorInfo {
  name: 'PulseError';
}

// ─── Events ──────────────────────────────────────────────────────────────────────────────────

export interface PulseEvents {
  /** After any committed change to these drafts or receipts (catalog already rewritten). */
  draftsChanged: { namespace: string; ids: string[] };
  /** Throttled to ≤ 4/s per draft. */
  uploadProgress: {
    draftId: string;
    uploadId?: string;
    fraction: number;
    bytesSent: number;
    bytesTotal: number;
  };
  /** Every flow result, also the ones drained from the inbox after a WebView reload. */
  flowResult: FlowResult;
  /** Debug builds with `policy.logs: 'host'` only. */
  log: { level: 'debug' | 'info' | 'warn' | 'error'; line: string; callId?: string; at: number };
}
export type PulseEventName = keyof PulseEvents;

// ─── The client ──────────────────────────────────────────────────────────────────────────────

export interface PulseClient {
  /** True when a native Pulse plugin is present and `info().supported`. Never rejects. */
  isAvailable(): Promise<boolean>;
  getInfo(): Promise<PulseInfo>;
  /** Call once per WebView load, before anything else. Repeating it replaces the options. */
  configure(o: ConfigureOptions): Promise<void>;
  /** PR2. On sign-in and on session restore, before the first read; `null` on sign-out. */
  setAccount(a: PulseAccount | null): Promise<AccountState>;
  /** Loads the bundle without presenting. Safe to call often. */
  prewarm(): Promise<void>;

  /** Resolves when the flow ends (minutes later). Lost across a WebView reload: use `pendingResults`. */
  open(r: OpenRequest): Promise<FlowResult>;
  record(context: PulseContext, o?: Omit<RecordRequest, 'entry' | 'context'>): Promise<FlowResult>;
  edit(draftId: string, o?: Omit<EditRequest, 'entry' | 'draftId'>): Promise<FlowResult>;
  exportDraft(draftId: string, o?: Omit<ExportRequest, 'entry' | 'draftId'>): Promise<FlowResult>;
  /**
   * Close the open flow; the take is kept (`closed{reason:'host'}`), or deleted with `discard`
   * (PLAN-final §8 / Q4). No-op when nothing is open.
   */
  close(o?: CloseOptions): Promise<void>;
  isOpen(): Promise<boolean>;
  /** Results written but not acknowledged, oldest first (durable inbox, AD15). */
  pendingResults(): Promise<FlowResult[]>;
  /** Deletes the result and its files under `results/`. */
  acknowledge(requestId: string): Promise<void>;

  // Data API (PR2). Reads come from the catalog and never start Pulse's runtime.
  listDrafts(f?: DraftFilter): Promise<DraftSummary[]>;
  getDraft(id: string): Promise<DraftSummary | null>;
  countDrafts(o: CountOptions): Promise<Record<string, number>>;
  renameDraft(id: string, name: string): Promise<void>;
  /** Move to…: only while unsent (not after Send, Q15); `draft.locked` otherwise. */
  setDraftContext(id: string, context: PulseContext): Promise<void>;
  deleteDraft(id: string): Promise<void>;
  /** Send from the host's list: merges if stale, then queues. Resolves once queued (not uploaded). */
  upload(id: string): Promise<{ clientKey: string; draftKey: string; sentAt: number }>;
  /** Back to 'draft' from queued/uploading/needs_credentials/failed; `draft.locked` while delivering. */
  cancelUpload(id: string): Promise<void>;
  /** 'pulse' mode: a hint (Pulse re-checks the status route). 'file' mode: deletes the draft now. */
  retireDraft(id: string): Promise<void>;
  /** Stops a 'kept' receipt counting for attention (after the host moved the video). */
  dismissReceipt(id: string): Promise<void>;
  /** Runs the launch rule (PLAN §6.3) now. Call on app resume. */
  resumeOutbox(): Promise<void>;
  usage(): Promise<Usage>;
  listNamespaces(): Promise<NamespaceInfo[]>;
  /** Deletes a namespace's drafts, receipts, jobs and files. Default: the active one. `busy` while a flow is open. */
  purge(o?: { namespace?: string }): Promise<void>;
  logFile(): Promise<FileRef>;

  /** Registers the handlers for host requests. Requests queue until this is called (≤ 20 s). */
  setHostServices(s: HostServices): void;

  on<E extends PulseEventName>(event: E, cb: (payload: PulseEvents[E]) => void): () => void;
}

// ─── Transport seam (native-bridge.md) ───────────────────────────────────────────────────────

/** The envelope every native call resolves with. */
export type BridgeReply =
  | { v: 1; callId: string; ok: true; result: Json }
  | { v: 1; callId: string; ok: false; error: PulseErrorInfo };

export interface BridgeEvent {
  v: 1;
  name: PulseEventName | 'hostRequest' | (string & {});
  payload: Json;
}

/**
 * What the Capacitor and Cordova adapters implement, and what a test build installs as
 * `window.__PULSE_ADAPTER__`. `call` never rejects for a Pulse error (it resolves ok:false);
 * it rejects only when the transport itself failed.
 */
export interface PulseAdapter {
  readonly kind: 'capacitor' | 'cordova' | 'fake' | (string & {});
  present(): Promise<boolean>;
  call(method: string, args: Json, callId: string): Promise<BridgeReply>;
  subscribe(cb: (e: BridgeEvent) => void): () => void;
  /** Native absolute path → URL the WebView can load. */
  toWebUrl(path: string): string;
}

export interface CreateClientOptions {
  /** Default: window.__PULSE_ADAPTER__, then Capacitor, then Cordova, else an adapter whose `present()` is false. */
  adapter?: PulseAdapter;
  /** Per forwarded call, default 30 s (a cold boot is included). `open` has none. */
  timeoutMs?: number;
}

// ─── '@mieweb/pulse-embed/react' types ───────────────────────────────────────────────────────

export interface Loadable<T> {
  data: T | undefined;
  loading: boolean;
  error: PulseErrorInfo | null;
  refresh(): void;
}

// ─── '@mieweb/pulse-embed/testing' types ─────────────────────────────────────────────────────

/** What the fake does when a flow opens, in order; then it repeats the last step. */
export type FakeFlowStep =
  | { result: 'sent'; durationMs?: number; name?: string }
  | { result: 'file' }
  | { result: 'kept' }
  | { result: 'discarded' }
  | { result: 'failed'; code: string };

export interface FakePulseScript {
  info?: Partial<PulseInfo>;
  drafts?: DraftSummary[];
  flows?: FakeFlowStep[];
  /**
   * With a server, the fake uploads for real: it calls the host's getUploadTarget, then sends
   * `fixture` over TUS (tus-js-client) to `endpoint` and polls the status route.
   */
  server?: { fixture: Blob | ArrayBuffer; pollMs?: number };
  /** Simulate a WebView reload: the next open's result goes only to the inbox. */
  dropNextResult?: boolean;
  latencyMs?: number;
}

export interface FakePulse {
  adapter: PulseAdapter;
  client: PulseClient;
  /** Push a raw event (e.g. a newer field) through the adapter. */
  emit(name: string, payload: Json): void;
  /** Every call the client made, for assertions. */
  calls: { method: string; args: Json }[];
  setOnline(online: boolean): void;
  lastResult(): FlowResult | null;
}

// ─── Page globals ────────────────────────────────────────────────────────────────────────────

declare global {
  interface Window {
    /** Test builds only: the adapter `createPulseClient` uses first. */
    __PULSE_ADAPTER__?: PulseAdapter;
  }
}
