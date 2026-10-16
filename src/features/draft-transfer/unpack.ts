import { File } from 'expo-file-system';
import { strFromU8, unzipSync } from 'fflate';

import { insertImportedDraft } from '@/db/drafts';
import { describeError } from '@/features/upload/upload-log';
import { conformToContract } from '@/utils/contract-gate';
import {
  absolutize,
  deleteDraftDir,
  editCoverRelPath,
  editedThumbRelPath,
  thumbRelPath,
  toFileUri,
  writeEditedBytes,
  writeOriginalBytes,
} from '@/utils/file-store';
import { importFailureNote } from '@/utils/import-copy';
import { editTimelineMs, parseEdit } from '@/utils/segment-window';
import { generateThumbnailFile, getDurationMs } from '@/utils/video';
import { isPulseManifest, MANIFEST_NAME } from './manifest';

/** A clip the bundle carried that was left out of its draft. */
export type SkippedClip = {
  /** Position of its draft in the bundle, and of the clip in that draft (both 0-based). */
  draftIndex: number;
  clipIndex: number;
  /** Short user-facing reason ("damaged video"), for a summary line. */
  reason: string;
  /** The underlying error, for the log. */
  detail: string;
};

export type ImportResult = { draftIds: string[]; skipped: SkippedClip[] };

/** "3 clips skipped: damaged video" — the reason only when every skipped clip shares it. */
export function skippedSummary(skipped: SkippedClip[]): string {
  const n = skipped.length;
  const reasons = new Set(skipped.map((s) => s.reason));
  const head = `${n} clip${n === 1 ? '' : 's'} skipped`;
  return reasons.size === 1 ? `${head}: ${skipped[0].reason}` : head;
}

const BAD_FILE = 'This file isn’t a valid .pulse bundle.';

/** Conform a stored clip to the reels contract in place; true when it had to be rewritten. */
async function conformInPlace(rel: string): Promise<boolean> {
  const conformed = await conformToContract(absolutize(rel));
  if (!conformed) return false;
  const dest = new File(absolutize(rel));
  dest.delete();
  await new File(toFileUri(conformed.path)).move(dest);
  return true;
}

/** An editState with its crop removed (everything else — undo/redo included — kept). */
function withoutCrop(editState: string): string {
  return JSON.stringify({ ...JSON.parse(editState), crop: null });
}

/**
 * An editState's trim bounded to the stored original, whose picture can end elsewhere than the
 * sender's (conforming re-times it): an out-point at the sender's end stays at the end, and a
 * window left empty is dropped (the whole clip, the rest of the edit kept).
 */
function withinSource(editState: string, sentMs: number, durationMs: number): string {
  const o = JSON.parse(editState);
  const endMs = o.endMs >= sentMs ? durationMs : Math.min(o.endMs, durationMs);
  return JSON.stringify(
    o.startMs < endMs ? { ...o, endMs } : { ...o, startMs: 0, endMs: durationMs },
  );
}

/** A stored clip's picture length; throws (a skip) when it has none. */
async function videoMs(rel: string): Promise<number> {
  const ms = await getDurationMs(absolutize(rel));
  if (ms <= 0) throw new Error('no video stream after conforming');
  return ms;
}
const TOO_BIG = 'This .pulse bundle is too large to import.';

// Our own exports are STORE-only (see pack.ts), so decompressed ≈ file size; a
// bundle whose entries claim to inflate far beyond the cap is a deflate bomb,
// not a real export. The whole archive is held in memory during import, so the
// cap also keeps legitimate-but-huge files from OOMing the app.
const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024; // 1 GiB

/**
 * Unpack a `.pulse` bundle: validate it, write each clip back to disk under a FRESH draft id
 * (never the source's — so importing can't clobber a local draft and a bundle can be imported
 * repeatedly), regenerate thumbnails, then commit the rows. Each draft is independent: a bad
 * one is rolled back (its files removed) and skipped rather than aborting the whole import.
 */
export async function importPulseFile(fileUri: string): Promise<ImportResult> {
  const file = new File(fileUri);
  if ((file.size ?? 0) > MAX_BUNDLE_BYTES) throw new Error(TOO_BIG);
  const bytes = await file.bytes();

  let archive: Record<string, Uint8Array>;
  try {
    let declaredTotal = 0;
    archive = unzipSync(bytes, {
      filter: (entry) => {
        declaredTotal += entry.originalSize;
        if (declaredTotal > MAX_BUNDLE_BYTES) throw new Error(TOO_BIG);
        return true;
      },
    });
  } catch (e) {
    throw new Error(e instanceof Error && e.message === TOO_BIG ? TOO_BIG : BAD_FILE);
  }

  const manifestEntry = archive[MANIFEST_NAME];
  if (!manifestEntry) throw new Error(BAD_FILE);

  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(manifestEntry));
  } catch {
    throw new Error('This .pulse bundle is corrupted.');
  }
  if (!isPulseManifest(manifest))
    throw new Error('This .pulse bundle is corrupted or unsupported.');

  // One id base for the batch; offsetting by index keeps draft ids unique and stamps
  // lastModified in import order.
  const base = Date.now();
  const draftIds: string[] = [];
  const skipped: SkippedClip[] = [];

  for (let draftIndex = 0; draftIndex < manifest.drafts.length; draftIndex++) {
    const draft = manifest.drafts[draftIndex];
    const draftId = String(base + draftIndex);

    try {
      const segmentRows = [];
      for (let segIndex = 0; segIndex < draft.segments.length; segIndex++) {
        const seg = draft.segments[segIndex];
        // A file the manifest references that the archive doesn't hold.
        const missing = (path: string) =>
          skipped.push({
            draftIndex,
            clipIndex: segIndex,
            reason: 'missing from the file',
            detail: `${path} is not in the archive`,
          });
        const origBytes = archive[seg.original];
        if (!origBytes) {
          missing(seg.original);
          continue;
        }
        let editState =
          typeof seg.editState === 'string' && parseEdit(seg.editState) ? seg.editState : null;
        const editedBytes = seg.edited ? archive[seg.edited] : undefined;
        // A legacy baked edit travels only as its file: without it the clip would come in unedited.
        if (!editState && seg.edited && !editedBytes) {
          missing(seg.edited);
          continue;
        }
        const skip = (e: unknown) => {
          const detail = describeError(e);
          skipped.push({
            draftIndex,
            clipIndex: segIndex,
            reason: importFailureNote(detail),
            detail,
          });
          console.warn('[draft-transfer] skipped clip', draftIndex, segIndex, detail);
        };

        const segmentId = `${draftId}-${segIndex}`;
        const originalFilename = writeOriginalBytes(draftId, segmentId, origBytes);

        // Enforce the portrait reels contract on foreign media: bundles from older installs
        // can carry off-canvas / non-H.264 clips that would otherwise enter the draft unchecked.
        // Conform in place (before the thumbnail, so the cover reflects the stored pixels);
        // a clip that can't be conformed is dropped like one missing from the archive. Its length
        // is the stored picture's, not the sender's (conforming can re-time it).
        let originalConformed: boolean;
        let durationMs: number;
        try {
          originalConformed = await conformInPlace(originalFilename);
          durationMs = await videoMs(originalFilename);
        } catch (e) {
          skip(e);
          try {
            new File(absolutize(originalFilename)).delete();
          } catch {}
          continue;
        }

        // An edit travels as settings (preferred — the recipient keeps editing and the export
        // renders it) and, from older installs, also as a baked file. A crop is normalized to the
        // original's frame, so it can't be trusted once conforming reshaped that frame: fall back
        // to the baked file when there is one, else keep the rest of the edit without the crop.
        if (editState && originalConformed && parseEdit(editState)?.crop) {
          editState = editedBytes ? null : withoutCrop(editState);
        }
        if (editState) editState = withinSource(editState, seg.durationMs, durationMs);

        let editedFilename: string | null = null;
        let editedDurationMs: number | null = null;
        let coverRel = thumbRelPath(draftId, segmentId);
        let ok: boolean;
        if (editState) {
          editedDurationMs = editTimelineMs(editState);
          coverRel = editCoverRelPath(draftId, segmentId, Date.now());
          ok = await generateThumbnailFile(absolutize(originalFilename), absolutize(coverRel), {
            editState,
            startMs: parseEdit(editState)?.startMs ?? 0,
          });
        } else if (editedBytes) {
          // A legacy baked edit: kept as the clip's file, played whole.
          editedFilename = writeEditedBytes(draftId, segmentId, editedBytes);
          try {
            await conformInPlace(editedFilename);
            editedDurationMs = await videoMs(editedFilename);
          } catch (e) {
            skip(e);
            for (const rel of [originalFilename, editedFilename]) {
              try {
                new File(absolutize(rel)).delete();
              } catch {}
            }
            continue;
          }
          coverRel = editedThumbRelPath(editedFilename);
          ok = await generateThumbnailFile(absolutize(editedFilename), absolutize(coverRel));
        } else {
          ok = await generateThumbnailFile(absolutize(originalFilename), absolutize(coverRel));
        }

        segmentRows.push({
          id: segmentId,
          draftId,
          order: typeof seg.order === 'number' ? seg.order : segIndex,
          label: '', // set below once the rows are sorted
          originalFilename,
          durationMs,
          editedFilename,
          editedDurationMs,
          editState,
          thumbnail: ok ? coverRel : null,
        });
      }

      if (segmentRows.length === 0) {
        deleteDraftDir(draftId);
        continue;
      }

      // Honor the bundle's declared ordering, then renumber sequentially: duplicate/holey
      // `order` values in a foreign bundle would trip the unique (draftId, order) index and
      // abort the import. The label (thumb badge) restarts fresh — import order IS this
      // device's creation order for the draft.
      segmentRows.sort((a, b) => a.order - b.order);
      segmentRows.forEach((row, i) => {
        row.order = i;
        row.label = String(i + 1);
      });

      await insertImportedDraft(
        {
          id: draftId,
          name: draft.name ?? null,
          // Seed the badge counter past the labels minted above so later recordings continue
          // from n+1 instead of reusing numbers.
          lastClipNumber: segmentRows.length,
          createdAt: typeof draft.createdAt === 'number' ? draft.createdAt : base,
          lastModified: base + draftIndex, // freshly imported → surface at the top of the list
        },
        segmentRows,
      );
      draftIds.push(draftId);
    } catch (e) {
      deleteDraftDir(draftId); // roll back this draft's files; keep importing the rest
      console.warn('[draft-transfer] failed to import draft', draftIndex, e);
    }
  }

  if (draftIds.length === 0) {
    const why = skipped.length > 0 ? ` (${skippedSummary(skipped)})` : '';
    throw new Error(`No drafts could be imported from this file${why}.`);
  }
  return { draftIds, skipped };
}
