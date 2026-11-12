import { sha256 } from '@noble/hashes/sha256';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import {
  isSafePulsePath,
  parsePulseYaml,
  stringifyPulseYaml,
  validatePulseDocument,
  type PulseAsset,
  type PulseDocument,
} from './document';

export const PULSE_YAML_ENTRY = 'pulse.yaml';
export const PULSE_YAML_HASH_ENTRY = 'pulse.sha256';
/** Bound both directions: never create a file our own reader refuses for size. */
export const PULSE_MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
export type PulseArchiveOptions = { maxBytes?: number };
export type DecodedPulseArchive = {
  document: PulseDocument;
  /** Logical document paths, not arbitrary ZIP entry paths. */
  assets: Map<string, Uint8Array>;
};

export function pulseAssetSha256(bytes: Uint8Array): string {
  return Array.from(sha256(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
}

function byteLimit(options: PulseArchiveOptions): number {
  const limit = options.maxBytes ?? PULSE_MAX_ARCHIVE_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error('Invalid Pulse archive size limit.');
  return limit;
}

function assertBytes(asset: PulseAsset, bytes: Uint8Array | undefined) {
  if (!bytes) throw new Error(`Pulse archive is missing media: ${asset.path}`);
  if (bytes.byteLength !== asset.byteLength)
    throw new Error(`Pulse media size mismatch: ${asset.path}`);
  if (pulseAssetSha256(bytes) !== asset.sha256)
    throw new Error(`Pulse media checksum mismatch: ${asset.path}`);
}

/** Pure and synchronous: validate every asset before producing a lossless STORE ZIP. */
export function encodePulseArchive(
  document: PulseDocument,
  assets: ReadonlyMap<string, Uint8Array>,
  options: PulseArchiveOptions = {},
): Uint8Array {
  validatePulseDocument(document);
  const limit = byteLimit(options);
  const entries: Record<string, Uint8Array> = Object.create(null);
  entries[PULSE_YAML_ENTRY] = strToU8(stringifyPulseYaml(document));
  entries[PULSE_YAML_HASH_ENTRY] = strToU8(pulseAssetSha256(entries[PULSE_YAML_ENTRY]));
  let total = entries[PULSE_YAML_ENTRY].byteLength + entries[PULSE_YAML_HASH_ENTRY].byteLength;
  const expectedPaths = new Set(document.assets.map((a) => a.path));
  for (const path of assets.keys()) {
    if (!expectedPaths.has(path)) throw new Error(`Pulse media is absent from document: ${path}`);
  }
  for (const asset of document.assets) {
    const bytes = assets.get(asset.path);
    assertBytes(asset, bytes);
    if (!Object.hasOwn(entries, asset.archivePath)) {
      total += bytes!.byteLength;
      if (total > limit) throw new Error('This .pulse archive is too large.');
      entries[asset.archivePath] = bytes!;
    }
  }
  if (total > limit) throw new Error('This .pulse archive is too large.');
  const archive = zipSync(entries, { level: 0 });
  if (archive.byteLength > limit) throw new Error('This .pulse archive is too large.');
  return archive;
}

/** Shared ZIP safety gate for both the v2 reader and the explicitly separate v1 importer. */
export function readPulseArchiveEntries(
  bytes: Uint8Array,
  options: PulseArchiveOptions = {},
): Record<string, Uint8Array> {
  const limit = byteLimit(options);
  if (bytes.byteLength > limit) throw new Error('This .pulse archive is too large.');
  const seen = new Set<string>();
  let expanded = 0;
  try {
    return unzipSync(bytes, {
      filter: (entry) => {
        if (!isSafePulsePath(entry.name))
          throw new Error(`Unsafe Pulse archive entry: ${entry.name}`);
        if (seen.has(entry.name)) throw new Error(`Duplicate Pulse archive entry: ${entry.name}`);
        seen.add(entry.name);
        if (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0) {
          throw new Error('Invalid Pulse archive entry size.');
        }
        expanded += entry.originalSize;
        if (expanded > limit) throw new Error('This .pulse archive expands beyond its size limit.');
        return true;
      },
    });
  } catch (error) {
    throw new Error(
      `Could not read Pulse archive: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Decode all bytes and verify all hashes before a caller writes any restored state/media. */
export function decodePulseArchive(
  bytes: Uint8Array,
  options: PulseArchiveOptions = {},
): DecodedPulseArchive {
  return decodePulseArchiveEntries(readPulseArchiveEntries(bytes, options));
}

export function decodePulseArchiveEntries(
  entries: Record<string, Uint8Array>,
): DecodedPulseArchive {
  const yaml = entries[PULSE_YAML_ENTRY];
  if (!yaml)
    throw new Error('This archive has no pulse.yaml; legacy v1 requires the import-copy reader.');
  const expectedHash = entries[PULSE_YAML_HASH_ENTRY];
  if (!expectedHash || strFromU8(expectedHash) !== pulseAssetSha256(yaml)) {
    throw new Error('Pulse document checksum mismatch.');
  }
  const document = parsePulseYaml(strFromU8(yaml));
  const declared = new Set([
    PULSE_YAML_ENTRY,
    PULSE_YAML_HASH_ENTRY,
    ...document.assets.map((a) => a.archivePath),
  ]);
  for (const name of Object.keys(entries)) {
    if (!declared.has(name))
      throw new Error(`Pulse archive entry is absent from document: ${name}`);
  }
  const assets = new Map<string, Uint8Array>();
  const verified = new Set<string>();
  for (const asset of document.assets) {
    const bytes = entries[asset.archivePath];
    if (!verified.has(asset.archivePath)) {
      assertBytes(asset, bytes);
      verified.add(asset.archivePath);
    }
    assets.set(asset.path, bytes);
  }
  return { document, assets };
}
