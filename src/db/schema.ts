import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch('subsec') * 1000)`;

/**
 * A draft's upload: `uploading` from the moment Upload is tapped until the run settles, then
 * `uploaded` — or back to NULL (unpaired) when it fails or is cancelled. There is no failed
 * state.
 */
type UploadStatus = 'uploading' | 'uploaded';

/** A draft — an ordered set of segments, plus its upload destination. */
export const drafts = sqliteTable(
  'drafts',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    // Per-draft upload destination (§4). A draft is "paired" when these are set (via
    // `setUploadDestination`); there is no separate mode flag. `uploadArtifactId` is the video's
    // artifact id from the pairing deep link — the TUS artifactId of the video, and the `relatedTo`
    // of its captions / beat manifest / thumbnail.
    uploadServer: text('upload_server'),
    // The link's bearer token isn't stored with the draft at all: the upload carries it in memory.
    uploadArtifactId: text('upload_artifact_id'),
    uploadStatus: text('upload_status', { enum: ['uploading', 'uploaded'] }).$type<UploadStatus>(),
    // The place the draft was recorded for, when a link that names one (`ref`) opened its recorder:
    // that link's server and `ref`, which match the place's row in `upload_destinations` while it
    // has one. Its export screen uploads there; a later link for the same place reopens the draft
    // while it is unsent. Null otherwise.
    contextServer: text('context_server'),
    contextRef: text('context_ref'),
    // The persisted merged export at `drafts/{id}/export.mp4` (see `exportRelPath`): the
    // `mergedSignature` of the clip set it was merged from, and its true duration (feeds the beat
    // manifest). Written only after the file is in place. Clip edits leave it alone: the export
    // screen reuses it only while the signature matches the current clips (so undoing edits gets
    // it back), and a mismatch or missing file means "merge again". Null = no export.
    mergedSignature: text('merged_signature'),
    mergedDurationMs: integer('merged_duration_ms'),
    // Where the captions sit on the video: the caption's vertical centre, as a fraction of the
    // picture's height (0 top, 1 bottom), dragged on the editor's preview. Null = the default place.
    captionY: real('caption_y'),
    // Monotonic badge counter: the highest clip number ever minted for this draft. Bumped on
    // every clip added, never decremented — so deleting (or renaming) a clip can never cause
    // its number to be reused.
    lastClipNumber: integer('last_clip_number').notNull().default(0),
    createdAt: integer('created_at').notNull().default(now),
    lastModified: integer('last_modified').notNull().default(now),
    // The host place this draft is for, when a host app embeds Pulse (its PulseContext). Null in
    // the Pulse app, whose link places use `contextServer`/`contextRef`. `contextKey` is
    // `${kind}:${id}`, what the host groups and counts drafts by; `contextJson` is the rest of the
    // context and `uploadTypeJson` its upload type, each at most 8 KB (host-context.ts checks all
    // four). Set at birth or by `setDraftContext` while the draft is unsent; frozen from Send on.
    contextKey: text('context_key'),
    contextLabel: text('context_label'),
    contextJson: text('context_json'),
    uploadTypeJson: text('upload_type_json'),
    // Which shell made the draft: 'app' (the Pulse app; every row before migration 0020) or 'host'.
    createdVia: text('created_via', { enum: ['app', 'host'] })
      .notNull()
      .default('app'),
    // When the host confirmed the draft's Send (a clock action ran for it). Set, the draft is
    // clock-bound: it keeps its place (`setDraftContext` refuses) and a later Send keeps `sentAt`.
    hostConfirmedAt: integer('host_confirmed_at'),
    // When the person first tapped Send for this draft (the time a clock action is recorded at).
    sentAt: integer('sent_at'),
  },
  // Not unique: a place may have several drafts.
  (t) => [index('drafts_context_key_idx').on(t.contextKey)],
);

/**
 * A clip on the timeline. The `originalFilename` recording/import is never mutated. An edit
 * (trim, transforms, mute, speed) is stored as settings in `editState` and applied when the clip
 * plays and when the export's merge renders it, so re-editing never compounds loss; reset nulls
 * the edit columns. Older versions baked edits into a re-encoded `editedFilename`, still played
 * when present. The effective file is `editedFilename ?? originalFilename` and the effective
 * duration is `editedDurationMs ?? durationMs`.
 */
export const segments = sqliteTable(
  'segments',
  {
    id: text('id').primaryKey(),
    draftId: text('draft_id')
      .notNull()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    order: integer('sort_order').notNull(),
    // Clip name shown on the thumb badge. Minted from the draft's `lastClipNumber` counter
    // at insert and NEVER renumbered — reorder mutates `order`, delete leaves gaps — so the
    // badge stays a stable identity for the draft's lifetime; a future rename feature just
    // overwrites it. Cosmetic metadata only — never part of the segment-set signature, so
    // renaming can't invalidate a merged transcript.
    label: text('label'),
    // Pristine source clip (relative path) — never mutated.
    originalFilename: text('original_filename').notNull(),
    durationMs: integer('duration_ms').notNull(),
    // A baked edit from an older version (relative path; null for edits stored as settings), and
    // the clip's edited timeline length (null when unedited).
    editedFilename: text('edited_filename'),
    editedDurationMs: integer('edited_duration_ms'),
    // The edit as settings (trim range, rotation, flip, crop, mute, speed) in the JSON shape
    // `parseEdit` reads (older versions also kept an undo/redo history in it). Null when
    // unedited.
    editState: text('edit_state'),
    // First-frame jpeg cover (relative path), written by the recorder/importer/editor.
    // Shown on segment-bar thumbs and draft cards (the draft cover is the first clip's
    // thumbnail) and uploaded as the merged session's thumbnail artifact.
    thumbnail: text('thumbnail'),
    // The clip's captions as the person edited them in the editor: JSON `{ file, words }`, the
    // words timed in that file like a clip transcript's (centiseconds), so trims, speed and
    // reorders carry them along. Used instead of the model's words while `file` is the clip's
    // file. Null = the model's words.
    captionEdit: text('caption_edit'),
  },
  // One slot per position: catches any regression of the order-assignment race at write time
  // (addSegment computes order inside a transaction; reorder renumbers in two passes).
  (t) => [uniqueIndex('segments_draft_order_unique').on(t.draftId, t.order)],
);

/**
 * On-device speech-to-text for a draft's MERGED video (whisper.rn). One row per draft,
 * produced once at export time from the concatenated timeline — NOT per segment. `signature`
 * is the effective-file signature of the segment set the transcript was cut against
 * (`segments.map(effFile).join('|')`, the same string `useExport` keys its merge on); when the
 * clip set changes the merged timeline moves, so a mismatching signature marks BOTH `lines` and
 * `editedLines` stale and triggers a re-transcribe on the next export. `lines` is JSON of
 * `Array<{ text, t0, t1, words? }>` with t0/t1 in centiseconds on the merged timeline (0-based,
 * no stitching). `editedLines` holds the user's hand-edited captions (same JSON shape); when
 * present AND same-signature it is the effective transcript. `durationMs` is the true merged
 * duration this transcript was cut against (used to reconcile the beat manifest timecodes).
 */
export const draftTranscripts = sqliteTable('draft_transcripts', {
  draftId: text('draft_id')
    .primaryKey()
    .references(() => drafts.id, { onDelete: 'cascade' }),
  // Effective-file signature of the segment set this transcript was produced from. A change
  // (add/remove/reorder/destructive-edit) invalidates the merged transcript incl. hand-edits.
  signature: text('signature').notNull(),
  // The Whisper model id that produced (or is producing) this transcript.
  model: text('model'),
  status: text('status', { enum: ['processing', 'done', 'error'] })
    .notNull()
    .default('processing'),
  lines: text('lines'),
  // User-edited captions (JSON, same shape as `lines`). Null = no manual edit. Effective only
  // while `signature` still matches the current segment set; a change clears it (timings stale).
  editedLines: text('edited_lines'),
  // True merged duration (ms) this transcript was cut against — from the native MergeResult.
  durationMs: integer('duration_ms'),
  createdAt: integer('created_at').notNull().default(now),
});

/**
 * A clip's own transcript, per model: the words of the file the clip plays from (`file`, the
 * original for edits stored as settings), timed in THAT file (centiseconds), so trims, speed,
 * mutes and reorders never make it stale — the draft's captions are composed from these through
 * the clips' edits (compose.ts). Made once per clip by the background queue (clip-queue.ts).
 * `words` is JSON `Array<{ text, t0, t1 }>` (whole words), `[]` for a clip with no speech, null
 * after a failure. A row whose `file` isn't the clip's current file is stale.
 */
export const clipTranscripts = sqliteTable(
  'clip_transcripts',
  {
    segmentId: text('segment_id')
      .notNull()
      .references(() => segments.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    file: text('file').notNull(),
    status: text('status', { enum: ['done', 'error'] }).notNull(),
    words: text('words'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.segmentId, t.model] })],
);

/** App-wide key/value settings (e.g. the selected transcription model). */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

/**
 * The pool of upload destinations the device has paired with (via `pulsecam://` deep links)
 * but not yet consumed. Unlike a draft's `drafts.upload*` columns (which record where a
 * specific draft is being/has been sent), this is a device-wide list any draft can pick from
 * at upload time. Each row is single-use — its server-minted `artifactId` anchors exactly one
 * upload, so the row is deleted the moment a draft claims it (or the user deletes it).
 * A row whose link named a place (`ref`) is that place's one row until it is claimed: a newer link
 * for the place replaces its artifact.
 * The bearer token is NOT stored here (live capability credential) — it lives in
 * expo-secure-store keyed by `id`, not in this plaintext-at-rest table.
 */
export const uploadDestinations = sqliteTable(
  'upload_destinations',
  {
    id: text('id').primaryKey(), // local uuid (Crypto.randomUUID), also the secure-store token key
    server: text('server').notNull(),
    artifactId: text('artifact_id').notNull(),
    // The link's hints, when it named the place its upload is for: `ref` is the host's opaque key
    // for the place (one row per server + ref), `label` / `app` name it, and `returnUrl` is the
    // host page to go back to after the upload.
    ref: text('ref'),
    label: text('label'),
    app: text('app'),
    returnUrl: text('return_url'),
    createdAt: integer('created_at').notNull().default(now),
  },
  // NULLs are distinct in a SQLite unique index, so rows without a place never collide.
  (t) => [uniqueIndex('upload_destinations_server_ref_unique').on(t.server, t.ref)],
);

/**
 * The upload outbox of the embedded shell: one row per draft that was sent and hasn't retired yet.
 * Its `state` is the only persisted upload state of an embedded draft (the Pulse app keeps using
 * `drafts.upload*`). LOCAL: never in a backup or a `.pulse` file, and a restore leaves it alone
 * (project.ts `LOCAL_TABLES`). Deleting the draft deletes its job.
 */
export const uploadJobs = sqliteTable(
  'upload_jobs',
  {
    draftId: text('draft_id')
      .primaryKey()
      .references(() => drafts.id, { onDelete: 'cascade' }),
    state: text('state', {
      enum: ['preparing', 'queued', 'uploading', 'delivering', 'needs_credentials', 'failed'],
    }).notNull(),
    // `${installationId}:${draftId}:${sig16}`: changes with any edit (the merged signature).
    clientKey: text('client_key').notNull(),
    // `${installationId}:${draftId}`: the same for every Send of this draft.
    draftKey: text('draft_key').notNull(),
    // Frozen at Send: the export that is sent must match it.
    mergedSignature: text('merged_signature').notNull(),
    sentAt: integer('sent_at').notNull(),
    // From the host's upload target: the server's upload id, the video's artifact id (changes
    // when the artifact is renewed) and the PulseVault base URL.
    uploadId: text('upload_id'),
    artifactId: text('artifact_id'),
    endpoint: text('endpoint'),
    // JSON: the parts sent (captions, manifest, thumbnail, video), each with its artifact id,
    // file, size, TUS URL and done flag, so a later launch resumes them.
    partsJson: text('parts_json'),
    bytesTotal: integer('bytes_total'),
    // The video's last known offset: progress after a relaunch.
    bytesSent: integer('bytes_sent'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: integer('next_attempt_at'),
    // The token's expiry only: the token itself stays in memory.
    tokenExp: integer('token_exp'),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('upload_jobs_client_key_unique').on(t.clientKey)],
);

/**
 * Drafts the embedded shell sent, kept 7 days after delivery without their media: what the host
 * shows as sent. Written when the draft retires (its rows deleted in the same transaction).
 * `mediaDeletedAt` records that the draft's folder is gone, so a kill between the rows and the
 * files is finished at the next launch. LOCAL (see `uploadJobs`).
 */
export const uploadReceipts = sqliteTable(
  'upload_receipts',
  {
    // The retired draft's id: no foreign key, its row is gone.
    draftId: text('draft_id').primaryKey(),
    name: text('name').notNull(),
    contextKey: text('context_key'),
    contextLabel: text('context_label'),
    contextJson: text('context_json'),
    uploadTypeJson: text('upload_type_json'),
    outcome: text('outcome', { enum: ['done', 'kept'] }).notNull(),
    // The server's note for 'done', its reason for 'kept'.
    note: text('note'),
    reason: text('reason'),
    uploadId: text('upload_id').notNull(),
    artifactId: text('artifact_id').notNull(),
    clientKey: text('client_key').notNull(),
    clipCount: integer('clip_count').notNull(),
    durationMs: integer('duration_ms').notNull(),
    sentAt: integer('sent_at').notNull(),
    deliveredAt: integer('delivered_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    dismissedAt: integer('dismissed_at'),
    mediaDeletedAt: integer('media_deleted_at'),
  },
  (t) => [index('upload_receipts_context_key_idx').on(t.contextKey)],
);

/**
 * This install's own values (its installation id, the Wi-Fi-only choice). Unlike `settings`, which
 * travels in library backups, these never leave the phone: a backup restored on another phone
 * must not give two phones one installation id. LOCAL (see `uploadJobs`).
 */
export const localSettings = sqliteTable('local_settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

export type Draft = typeof drafts.$inferSelect;
export type Segment = typeof segments.$inferSelect;
export type DraftTranscript = typeof draftTranscripts.$inferSelect;
export type ClipTranscript = typeof clipTranscripts.$inferSelect;
export type UploadDestination = typeof uploadDestinations.$inferSelect;
export type UploadJob = typeof uploadJobs.$inferSelect;
export type UploadReceipt = typeof uploadReceipts.$inferSelect;
