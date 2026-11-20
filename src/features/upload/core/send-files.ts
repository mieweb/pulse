import * as Crypto from 'expo-crypto';
import { Directory, File } from 'expo-file-system';

import { segmentsForDraft } from '@/db/drafts';
import type { UploadPart } from '@/db/upload-jobs';
import { getDraftCaptions } from '@/features/transcription/draft-captions';
import { linesToVtt } from '@/features/transcription/vtt';
import { absolutize, exportRelPath, toFileUri } from '@/utils/file-store';
import { documentDir } from '@/utils/storage-root';
import { generateCoverFile } from '@/utils/video';

import { buildBeatManifest } from './beat-manifest';

// The files an embedded Send uploads, written at PREPARING into the draft's own folder
// (pulse-schema.md §3.2): the captions, the beat manifest and the cover, next to the export they
// go with (`drafts/<id>/export.mp4`, sent in place). On disk, a resume after a kill sends exactly
// what Send composed (the Pulse app's uploads hold them in memory and a cache folder instead).
// The folder goes with the draft when it retires or is deleted; no `.pulse` document references it.

/** The send folder, relative to the documents root. */
export function sendDirRelPath(draftId: string): string {
  return `drafts/${draftId}/send`;
}

/** The parts of a Send and the bytes its progress counts (the video's). */
export type SendFiles = { parts: UploadPart[]; bytesTotal: number };

function sendDir(draftId: string): Directory {
  return new Directory(documentDir(), 'drafts', draftId, 'send');
}

/** Write `name` in the send folder; returns its relative path and size. */
function writeText(draftId: string, name: string, text: string): { file: string; bytes: number } {
  const file = new File(sendDir(draftId), name);
  file.write(text);
  return { file: `${sendDirRelPath(draftId)}/${name}`, bytes: file.size ?? 0 };
}

function part(
  role: UploadPart['role'],
  artifactId: string | null,
  written: { file: string; bytes: number },
): UploadPart {
  return { role, artifactId, ...written, tusUrl: null, done: false };
}

/**
 * Write the draft's send files for its export of `durationMs` (merged before this), and list the
 * parts in the order they go: captions (only when it has some), the beat manifest, the cover (when
 * one can be made), then the video. The related parts get new artifact ids; the video's comes from
 * the host's upload target. Files of an earlier Send are replaced. Throws when the export is gone.
 */
export async function writeSendFiles(draftId: string, durationMs: number): Promise<SendFiles> {
  const videoRel = exportRelPath(draftId);
  const video = new File(absolutize(videoRel));
  if (!video.exists) throw new Error(`Draft ${draftId} has no export to send.`);
  const videoBytes = video.size ?? 0;

  const dir = sendDir(draftId);
  if (dir.exists) dir.delete();
  dir.create({ intermediates: true, idempotent: true });

  const parts: UploadPart[] = [];
  // Captions composed from the clips as they are at Send: on the merged timeline, through each
  // clip's trim, speed and order.
  const captions = await getDraftCaptions(draftId);
  if (captions.lines.length > 0) {
    const vtt = writeText(draftId, 'captions.vtt', linesToVtt(captions.lines, captions.y));
    parts.push(part('captions', Crypto.randomUUID(), vtt));
  }

  const segments = await segmentsForDraft(draftId);
  const manifest = buildBeatManifest(segments, durationMs);
  parts.push(
    part(
      'manifest',
      Crypto.randomUUID(),
      writeText(draftId, 'beats.pulse', JSON.stringify(manifest)),
    ),
  );

  // The cover: the export's first frame, else the first clip's list cover.
  const thumb = new File(dir, 'thumbnail.jpg');
  let haveThumb = await generateCoverFile(toFileUri(video.uri), thumb.uri).catch(() => false);
  if (!haveThumb || !thumb.exists) {
    const first = segments[0]?.thumbnail;
    const fallback = first ? new File(absolutize(first)) : null;
    haveThumb = !!fallback?.exists;
    if (fallback && haveThumb) {
      if (thumb.exists) thumb.delete();
      await fallback.copy(thumb);
    }
  }
  if (haveThumb && thumb.exists) {
    parts.push(
      part('thumbnail', Crypto.randomUUID(), {
        file: `${sendDirRelPath(draftId)}/thumbnail.jpg`,
        bytes: thumb.size ?? 0,
      }),
    );
  }

  parts.push(part('video', null, { file: videoRel, bytes: videoBytes }));
  return { parts, bytesTotal: videoBytes };
}
