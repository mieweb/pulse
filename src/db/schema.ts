import { sql } from 'drizzle-orm';
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch('subsec') * 1000)`;

/**
 * Lifecycle of a draft's upload. Deliberately has NO failed/retry state: a
 * terminal failure burns the pairing, resets the columns, and surfaces as a
 * transient toast — the draft simply returns to being editable/unpaired.
 */
type UploadStatus = 'idle' | 'uploading' | 'uploaded';

/** A draft — an ordered set of segments, plus its upload destination. */
export const drafts = sqliteTable('drafts', {
  id: text('id').primaryKey(),
  name: text('name'),
  // Per-draft upload destination (§4). A draft is "paired" when these are set (via
  // `setUploadDestination`); there is no separate mode flag. `uploadArtifactId` is the
  // session-anchor artifact id from the pairing deep link, used as the TUS artifactId for the
  // video and as `relatedTo` on its related artifacts. Pairings are SINGLE-SHOT: a terminal
  // upload failure clears these (the deep link is spent) — the user pairs a fresh link.
  uploadServer: text('upload_server'),
  // The bearer token itself is NOT stored here — it's a live capability credential, kept in
  // expo-secure-store instead (`db/secure-token.ts`), not in this plaintext-at-rest table.
  uploadArtifactId: text('upload_artifact_id'),
  // The artifact's serving URL once uploaded — the "watch" link. (While uploading it is a
  // launch-sweep probe target; it is never used to resume a transfer.)
  uploadResourceUrl: text('upload_resource_url'),
  uploadStatus: text('upload_status', {
    enum: ['idle', 'uploading', 'uploaded'],
  }).$type<UploadStatus>(),
  // Monotonic badge counter: the highest clip number ever minted for this draft. Bumped on
  // every clip added, never decremented — so deleting (or renaming) a clip can never cause
  // its number to be reused.
  lastClipNumber: integer('last_clip_number').notNull().default(0),
  createdAt: integer('created_at').notNull().default(now),
  lastModified: integer('last_modified').notNull().default(now),
});

/**
 * A clip on the timeline. The `originalFilename` recording/import is never mutated.
 * Editing is DESTRUCTIVE via react-native-video-trim: the editor (trim + transforms)
 * writes a new re-encoded file, stored as `editedFilename`. Re-editing always re-opens
 * the pristine original (no compounding loss); reset = delete the edited file + null
 * the edited columns. The effective file is `editedFilename ?? originalFilename` and the
 * effective duration is `editedDurationMs ?? durationMs`.
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
    // Re-encoded editor output (relative path) + its duration; null until edited.
    editedFilename: text('edited_filename'),
    editedDurationMs: integer('edited_duration_ms'),
    // First-frame jpeg cover (relative path), written by the recorder/importer/editor.
    // Shown on segment-bar thumbs and draft cards (the draft cover is the first clip's
    // thumbnail) and uploaded as the merged session's thumbnail artifact.
    thumbnail: text('thumbnail'),
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
 * upload session, so the row is deleted when a draft claims it.
 * The bearer token is NOT stored here (live capability credential) — it lives in
 * expo-secure-store keyed by `id`, same policy as the per-draft token above.
 */
export const uploadDestinations = sqliteTable('upload_destinations', {
  id: text('id').primaryKey(), // local uuid (Crypto.randomUUID), also the secure-store token key
  server: text('server').notNull(),
  artifactId: text('artifact_id').notNull(),
  // Whether the server advertised the presigned direct-upload profile when this link was
  // paired — the transport is DECIDED AT PAIRING (a capability change applies to new
  // pairings, never to a link already scanned).
  directUpload: integer('direct_upload', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull().default(now),
});

export type Draft = typeof drafts.$inferSelect;
export type Segment = typeof segments.$inferSelect;
export type DraftTranscript = typeof draftTranscripts.$inferSelect;
export type UploadDestination = typeof uploadDestinations.$inferSelect;
