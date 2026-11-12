import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import {
  commitPulseState,
  getPulseDocument,
  getPulsePublicationGeneration,
  restorePulseDocument,
} from '@/pulse/runtime';
import { copyPulseDrafts } from '@/pulse/transfer';
import {
  emptyPulseState,
  validatePulseDocument,
  validatePulseState,
  type PulseDocument,
  type PulseState,
} from '@/pulse/document';
import { pulseAssetSha256, type DecodedPulseArchive } from '@/pulse/archive';

function validateDecoded(decoded: DecodedPulseArchive) {
  validatePulseDocument(decoded.document);
  const paths = new Set(decoded.document.assets.map((asset) => asset.path));
  for (const path of decoded.assets.keys()) {
    if (!paths.has(path)) throw new Error(`Pulse media is absent from document: ${path}`);
  }
  for (const asset of decoded.document.assets) {
    const bytes = decoded.assets.get(asset.path);
    if (
      !bytes ||
      bytes.byteLength !== asset.byteLength ||
      pulseAssetSha256(bytes) !== asset.sha256
    ) {
      throw new Error(`Pulse media checksum mismatch: ${asset.path}`);
    }
  }
}

function assertWorkingAssetPaths(paths: Iterable<string>) {
  for (const path of paths) {
    const root = path.split('/')[0].toLowerCase();
    if (
      ['library.pulse', 'sqlite', 'models', 'logs'].includes(root) ||
      /^(pulse|pulse-cache)\.db(?:-wal|-shm)?$/.test(root)
    ) {
      throw new Error(`Pulse media path uses a reserved application directory: ${path}`);
    }
  }
}

/**
 * Stage and install a copy's newly namespaced bytes before its canonical commit. Retain a
 * backup in the unlikely event of an existing namespace collision. Once commit returns,
 * even a projection failure cannot authorize removing committed media.
 */
async function installAndCommit(
  assets: ReadonlyMap<string, Uint8Array>,
  commit: () => PulseDocument,
): Promise<PulseDocument> {
  assertWorkingAssetPaths(assets.keys());
  const staging = new Directory(Paths.cache, 'pulse-imports', Crypto.randomUUID());
  staging.create({ intermediates: true });
  const staged: {
    destination: File;
    source: File;
    backup: File;
    touched: boolean;
    existed: boolean;
  }[] = [];
  let committed = false;
  let rollbackFailed = false;
  try {
    let index = 0;
    for (const [path, bytes] of assets) {
      const source = new File(staging, `${index}.incoming`);
      source.write(bytes);
      const destination = new File(Paths.document, ...path.split('/'));
      staged.push({
        destination,
        source,
        backup: new File(staging, `${index}.previous`),
        touched: false,
        existed: destination.exists,
      });
      index++;
    }
    for (const entry of staged) {
      if (entry.existed) await entry.destination.copy(entry.backup);
      entry.destination.parentDirectory.create({ intermediates: true, idempotent: true });
      entry.touched = true;
      if (entry.destination.exists) entry.destination.delete();
      await entry.source.copy(entry.destination);
    }
    const document = commit();
    committed = true;
    return document;
  } catch (error) {
    if (!committed) {
      for (const entry of staged.reverse()) {
        if (!entry.touched) continue;
        try {
          if (entry.destination.exists) entry.destination.delete();
          if (entry.existed) await entry.backup.copy(entry.destination);
        } catch (rollbackError) {
          rollbackFailed = true;
          console.error('[draft-transfer] retained recovery staging', staging.uri, rollbackError);
        }
      }
    }
    if (rollbackFailed)
      throw new Error(
        `Pulse restore failed; working-file recovery remains at ${staging.uri}. ${String(error)}`,
      );
    throw error;
  } finally {
    // Cleanup is best effort after a committed revision; it cannot turn a saved import into a
    // reported failure or delete files that the canonical document now references.
    if (!rollbackFailed) {
      try {
        if (staging.exists) staging.delete();
      } catch (error) {
        console.warn('[draft-transfer] staging cleanup deferred', error);
      }
    }
  }
}

/** Default v2 behavior: copy projects while keeping device preferences and pairing local. */
export async function importPulseArchiveCopy(decoded: DecodedPulseArchive): Promise<string[]> {
  validateDecoded(decoded);
  const namespace = `imports/${Crypto.randomUUID()}`;
  // Reserve identities once, but merge against the latest canonical state only after all
  // asynchronous IO. Edits committed while files stage must not be overwritten by a stale read.
  const additions = copyPulseDrafts(emptyPulseState(), decoded.document, namespace, () =>
    Crypto.randomUUID(),
  );
  const assets = new Map(
    [...additions.mediaPaths].map(([path, source]) => {
      const bytes = decoded.assets.get(source);
      if (!bytes) throw new Error(`Pulse archive is missing media: ${source}`);
      return [path, bytes] as const;
    }),
  );
  await installAndCommit(assets, () => {
    const state: PulseState = getPulseDocument().state;
    state.drafts.push(...additions.state.drafts);
    state.segments.push(...additions.state.segments);
    state.draftTranscripts.push(...additions.state.draftTranscripts);
    state.clipTranscripts.push(...additions.state.clipTranscripts);
    validatePulseState(state);
    return commitPulseState(state);
  });
  return additions.draftIds;
}

/**
 * Explicit whole-state replacement; never called by the normal import-copy UI. The caller
 * must close active editor/recorder sessions and stop upload/transcription/background writers
 * before invoking this recovery API. Immutable canonical bytes publish first; the runtime
 * materializes working media afterward. A publication-generation check prevents discarding
 * a change acknowledged while the archive was being read/decoded, including revision ABA.
 */
export async function restoreDecodedPulseArchive(
  decoded: DecodedPulseArchive,
  expectedGeneration: number = getPulsePublicationGeneration(),
): Promise<PulseDocument> {
  validateDecoded(decoded);
  if (decoded.document.scope !== 'library')
    throw new Error('Exact library restore requires a library snapshot, not a selection.');
  assertWorkingAssetPaths(decoded.assets.keys());
  return restorePulseDocument(decoded.document, expectedGeneration, decoded.assets);
}
