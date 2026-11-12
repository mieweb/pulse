import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import { flushDraftWrites } from '@/features/editor/draft-writes';
import { encodePulseArchive } from '@/pulse/archive';
import type { PulseDocument } from '@/pulse/document';
import { getPulseDocument, readCanonicalPulseAsset } from '@/pulse/runtime';
import { selectPulseDrafts } from '@/pulse/transfer';

/** Reduce a draft name to a filesystem-safe slug for the single-draft filename. */
function safeName(name: string | null): string {
  const slug = (name ?? '')
    .replace(/[^a-z0-9-_ ]+/gi, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40);
  return slug || 'untitled';
}

/**
 * Share a complete v2 selection snapshot, including empty drafts, both original and legacy
 * baked files, transcript/correction rows and global metadata. Missing required media aborts
 * the export; nothing is silently skipped. Copy import has a separate, explicit trust policy.
 */
export async function exportDrafts(draftIds: string[], now: number): Promise<string> {
  await flushDraftWrites();
  const document = selectPulseDrafts(getPulseDocument(), draftIds);
  const name =
    document.state.drafts.length === 1
      ? `pulse-draft-${safeName(document.state.drafts[0].name)}-${now}.pulse`
      : `pulse-selection-${now}.pulse`;
  return writeSnapshot(document, name);
}

/** Full recovery snapshot, including every global row and every canonical asset descriptor. */
export async function exportPulseLibrary(now: number): Promise<string> {
  await flushDraftWrites();
  return writeSnapshot(getPulseDocument(), `pulse-library-${now}.pulse`);
}

function writeSnapshot(document: PulseDocument, name: string): string {
  const assets = new Map(
    document.assets.map((asset) => [asset.path, readCanonicalPulseAsset(asset.path)]),
  );
  const zipped = encodePulseArchive(document, assets);
  // Each share has its own directory: a new export must not remove a file a share target is
  // still reading. These are cache artifacts; canonical media remains in the live package.
  const dir = new Directory(Paths.cache, 'pulse-exports', Crypto.randomUUID());
  dir.create({ intermediates: true });
  const out = new File(dir, name);
  out.write(zipped);
  return out.uri;
}
