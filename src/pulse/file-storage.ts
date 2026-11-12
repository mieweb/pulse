import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { Directory, File, FileMode, Paths } from 'expo-file-system';

import {
  isSafePulsePath,
  referencedPulseAssetPaths,
  type PulseAsset,
  type PulseDocument,
  type PulseState,
} from './document';
import type { PulseStorage } from './repository';
import { pulseAssetSha256 } from './archive';

const CHUNK_BYTES = 1024 * 1024;
const INITIAL_UPGRADE_MARKER = 'initial-upgrade.json';
const INITIAL_UPGRADE_CONTENT = JSON.stringify({ format: 'pulse-initial-upgrade', version: 1 });

export function hashPulseFile(file: File): string {
  const handle = file.open(FileMode.ReadOnly);
  const digest = sha256.create();
  try {
    while ((handle.offset ?? 0) < (handle.size ?? 0)) {
      const bytes = handle.readBytes(
        Math.min(CHUNK_BYTES, (handle.size ?? 0) - (handle.offset ?? 0)),
      );
      if (!bytes.length) throw new Error('Could not read the complete Pulse media file.');
      digest.update(bytes);
    }
    return bytesToHex(digest.digest());
  } finally {
    handle.close();
  }
}

const hashText = (text: string) => bytesToHex(sha256(utf8ToBytes(text)));
const commitHash = (revision: number, sha256: string, slot: number) =>
  hashText(JSON.stringify({ revision, sha256, slot }));

/**
 * A live .pulse package: YAML revisions plus immutable content-addressed media.
 * A revision is published only by its final commit marker. The other slot remains intact
 * throughout replacement, so interruption never requires trusting an incomplete YAML file.
 */
export class NativePulseStorage implements PulseStorage {
  private readonly fingerprints = new Map<string, { fingerprint: string | null; sha256: string }>();
  private readonly verifiedCanonical = new Map<
    string,
    { fingerprint: string | null; sha256: string }
  >();

  constructor(
    readonly directory: Directory,
    private readonly workingDirectory: Directory = new Directory(Paths.document),
  ) {}

  private local(path: string): File {
    if (!isSafePulsePath(path)) throw new Error('Unsafe Pulse asset path.');
    const top = path.split('/')[0].toLowerCase();
    if (
      ['sqlite', 'models', 'logs'].includes(top) ||
      /^(pulse|pulse-cache)\.db(?:-wal|-shm)?$/.test(top)
    ) {
      throw new Error('Pulse working assets cannot overwrite reserved application storage.');
    }
    const file = new File(this.workingDirectory, ...path.split('/'));
    const root = this.directory.uri.replace(/\/+$/, '');
    if (file.uri === root || file.uri.startsWith(`${root}/`)) {
      throw new Error('Pulse working assets cannot overwrite their canonical package.');
    }
    return file;
  }

  private archived(path: string): File {
    if (!isSafePulsePath(path) || !path.startsWith('assets/')) {
      throw new Error('Unsafe canonical Pulse asset path.');
    }
    return new File(this.directory, ...path.split('/'));
  }

  private fingerprint(file: File): string | null {
    const info = file.info();
    if (!Number.isFinite(info.size) || !Number.isFinite(info.modificationTime)) return null;
    return `${info.size}:${info.modificationTime}`;
  }

  private sourceHash(path: string, file: File): string {
    const fingerprint = this.fingerprint(file);
    const cached = this.fingerprints.get(path);
    if (fingerprint !== null && cached?.fingerprint === fingerprint) return cached.sha256;
    const digest = hashPulseFile(file);
    this.fingerprints.set(path, { fingerprint, sha256: digest });
    return digest;
  }

  readCommits(): { revision: number; yaml: string }[] {
    if (!this.directory.exists) return [];
    const commits: { revision: number; yaml: string }[] = [];
    let orphanedCommit = false;
    for (const slot of [0, 1]) {
      const marker = new File(this.directory, `pulse-${slot}.commit`);
      if (!marker.exists) {
        // A deliberate interrupted replacement retains its staged marker. A final YAML
        // without either marker is damaged evidence, not permission to select an older save.
        if (
          new File(this.directory, `pulse-${slot}.yaml`).exists &&
          !new File(this.directory, `pulse-${slot}.commit.tmp`).exists
        )
          orphanedCommit = true;
        continue;
      }
      const value: unknown = JSON.parse(marker.textSync());
      const record = value as {
        revision?: unknown;
        sha256?: unknown;
        commitSha256?: unknown;
      } | null;
      if (
        !record ||
        !Number.isSafeInteger(record.revision) ||
        (record.revision as number) < 1 ||
        (record.revision as number) % 2 !== slot ||
        typeof record.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.sha256) ||
        typeof record.commitSha256 !== 'string' ||
        record.commitSha256 !== commitHash(record.revision as number, record.sha256, slot)
      ) {
        throw new Error('Invalid canonical Pulse commit marker. Recovery is required.');
      }
      const yaml = new File(this.directory, `pulse-${slot}.yaml`).textSync();
      if (hashText(yaml) !== record.sha256) {
        throw new Error('The committed Pulse YAML is damaged. Canonical files were left intact.');
      }
      commits.push({ revision: record.revision as number, yaml });
    }
    // With no index remaining, an interrupted initial migration and damaged saved markers
    // are indistinguishable. Retain the evidence and require explicit recovery instead of
    // silently creating an empty library over either case. A genuinely empty directory is safe.
    const initialUpgrade = new File(this.directory, INITIAL_UPGRADE_MARKER);
    if (initialUpgrade.exists && initialUpgrade.textSync() !== INITIAL_UPGRADE_CONTENT) {
      throw new Error('The initial Pulse upgrade marker is damaged. Recovery is required.');
    }
    if (commits.length === 0 && initialUpgrade.exists) return [];
    const contents = this.directory.list();
    if (
      commits.length === 0 &&
      contents.length === 1 &&
      contents[0].name === `${INITIAL_UPGRADE_MARKER}.tmp`
    )
      return [];
    if (commits.length === 0 && contents.length > 0) {
      throw new Error(
        'The canonical Pulse package has no committed revision. Recovery is required.',
      );
    }
    if (orphanedCommit) throw new Error('A Pulse commit marker is missing. Recovery is required.');
    return commits;
  }

  /** An incomplete first capture can retry from the retained legacy database. */
  prepareInitialMigration(): void {
    this.directory.create({ intermediates: true, idempotent: true });
    if (this.readCommits().length > 0) throw new Error('The Pulse library is already committed.');
    const marker = new File(this.directory, INITIAL_UPGRADE_MARKER);
    if (!marker.exists) {
      const staged = new File(this.directory, `${INITIAL_UPGRADE_MARKER}.tmp`);
      staged.write(INITIAL_UPGRADE_CONTENT);
      if (staged.textSync() !== INITIAL_UPGRADE_CONTENT)
        throw new Error('Could not verify initial Pulse upgrade staging.');
      staged.moveSync(marker);
    }
    if (marker.textSync() !== INITIAL_UPGRADE_CONTENT)
      throw new Error('Could not verify initial Pulse upgrade marker.');
  }

  finishInitialMigration(): void {
    const marker = new File(this.directory, INITIAL_UPGRADE_MARKER);
    if (marker.exists) marker.delete();
  }

  captureAssets(state: PulseState, previous: readonly PulseAsset[]): PulseAsset[] {
    this.directory.create({ intermediates: true, idempotent: true });
    const previousByPath = new Map(previous.map((asset) => [asset.path, asset]));
    const required = new Set(referencedPulseAssetPaths(state));
    const optional = state.segments.flatMap((segment) =>
      segment.thumbnail ? [segment.thumbnail] : [],
    );
    optional.push(
      ...state.drafts
        .filter((draft) => draft.mergedSignature !== null)
        .map((draft) => `drafts/${draft.id}/export.mp4`),
    );
    const assets: PulseAsset[] = [];
    for (const path of [...new Set([...required, ...optional])].sort()) {
      const source = this.local(path);
      const old = previousByPath.get(path);
      if (old && required.has(path)) {
        // Once accepted, source media belongs to the canonical package. A damaged or
        // overwritten working copy cannot become a new original during an unrelated edit.
        // Replacing an accepted source requires an explicit restore or a new logical path.
        this.verifyCanonicalAsset(old, true);
        assets.push({ ...old });
        continue;
      }
      if (!source.exists) {
        if (old && this.archived(old.archivePath).exists) {
          this.verifyCanonicalAsset(old, true);
          assets.push({ ...old });
          continue;
        }
        if (required.has(path)) throw new Error(`Required Pulse source media is missing: ${path}`);
        continue; // Missing cache bytes do not erase or reinterpret their persisted metadata.
      }
      const digest = this.sourceHash(path, source);
      const asset: PulseAsset =
        old?.sha256 === digest && old.byteLength === source.size
          ? { ...old }
          : {
              path,
              archivePath: `assets/${digest}`,
              byteLength: source.size,
              sha256: digest,
            };
      const target = this.archived(asset.archivePath);
      if (!target.exists) {
        target.parentDirectory.create({ intermediates: true, idempotent: true });
        const staged = new File(this.directory, 'assets', `${digest}.tmp`);
        source.copySync(staged, { overwrite: true });
        if (staged.size !== asset.byteLength || hashPulseFile(staged) !== digest) {
          throw new Error('Could not verify the staged canonical Pulse media.');
        }
        staged.moveSync(target);
        this.verifiedCanonical.set(asset.archivePath, {
          fingerprint: this.fingerprint(target),
          sha256: asset.sha256,
        });
      } else {
        // Existing content-addressed bytes may have been damaged since the last load.
        // Size alone cannot establish that this revision is safe to acknowledge.
        this.verifyCanonicalAsset(asset, true);
      }
      assets.push(asset);
    }
    // An accepted descriptor may be an extra source, stale transcript input or recovery
    // artifact. An unrelated edit cannot implicitly retire it or normalize its ZIP path.
    // A future explicit GC policy must decide when it is safe to remove these descriptors.
    const included = new Set(assets.map((asset) => asset.path));
    for (const old of previous) {
      if (!included.has(old.path)) {
        this.verifyCanonicalAsset(old, true);
        assets.push({ ...old });
      }
    }
    const currentByPath = new Map(assets.map((asset) => [asset.path, asset]));
    return [
      ...previous.map((asset) => currentByPath.get(asset.path)!),
      ...assets.filter((asset) => !previousByPath.has(asset.path)),
    ];
  }

  publish(document: PulseDocument, yaml: string, generation = document.revision): void {
    this.directory.create({ intermediates: true, idempotent: true });
    const slot = generation % 2;
    const target = new File(this.directory, `pulse-${slot}.yaml`);
    const marker = new File(this.directory, `pulse-${slot}.commit`);
    const staged = new File(this.directory, `pulse-${slot}.yaml.tmp`);
    const stagedMarker = new File(this.directory, `pulse-${slot}.commit.tmp`);
    const digest = hashText(yaml);
    staged.write(yaml);
    if (hashText(staged.textSync()) !== digest) throw new Error('Pulse YAML verification failed.');
    const markerText = JSON.stringify({
      revision: generation,
      sha256: digest,
      commitSha256: commitHash(generation, digest, slot),
    });
    stagedMarker.write(markerText);
    if (stagedMarker.textSync() !== markerText)
      throw new Error('Pulse commit marker verification failed.');
    if (marker.exists) marker.delete();
    if (target.exists) target.delete();
    staged.moveSync(target);
    // This rename publishes a complete YAML + verified immutable assets revision.
    stagedMarker.moveSync(marker);
    // Before any save is acknowledged, revoke permission to seed from the old database.
    // Failure here gates initial bootstrap; the newly committed files remain recoverable.
    this.finishInitialMigration();
  }

  /** Preserve incoming descriptors exactly, including extra assets and non-hash ZIP paths. */
  importAssets(assets: readonly PulseAsset[], incoming?: ReadonlyMap<string, Uint8Array>): void {
    this.directory.create({ intermediates: true, idempotent: true });
    for (const asset of assets) {
      const source = this.local(asset.path);
      const target = this.archived(asset.archivePath);
      if (target.exists) {
        // An immutable name collision is a recovery error, never permission to overwrite
        // bytes still referenced by another committed revision.
        this.verifyCanonicalAsset(asset, true);
        continue;
      }
      const bytes = incoming?.get(asset.path);
      if (
        incoming &&
        (!bytes ||
          bytes.byteLength !== asset.byteLength ||
          pulseAssetSha256(bytes) !== asset.sha256)
      ) {
        throw new Error(`Restored Pulse source media is missing or damaged: ${asset.path}`);
      }
      if (
        !incoming &&
        (!source.exists ||
          source.size !== asset.byteLength ||
          hashPulseFile(source) !== asset.sha256)
      ) {
        throw new Error(`Restored Pulse source media is missing or damaged: ${asset.path}`);
      }
      target.parentDirectory.create({ intermediates: true, idempotent: true });
      const staged = new File(this.directory, 'assets', `${asset.sha256}.restore.tmp`);
      if (bytes) staged.write(bytes);
      else source.copySync(staged, { overwrite: true });
      if (staged.size !== asset.byteLength || hashPulseFile(staged) !== asset.sha256) {
        throw new Error('Could not verify the restored canonical Pulse media.');
      }
      staged.moveSync(target);
      this.verifiedCanonical.set(asset.archivePath, {
        fingerprint: this.fingerprint(target),
        sha256: asset.sha256,
      });
      if (!incoming) {
        this.fingerprints.set(asset.path, {
          fingerprint: this.fingerprint(source),
          sha256: asset.sha256,
        });
      }
    }
  }

  verifyAssets(assets: readonly PulseAsset[]): void {
    const checked = new Set<string>();
    for (const asset of assets) {
      if (checked.has(asset.archivePath)) continue;
      // Every load hashes every distinct canonical file, even when this instance has a cache.
      this.verifyCanonicalAsset(asset, false);
      checked.add(asset.archivePath);
    }
  }

  private verifyCanonicalAsset(asset: PulseAsset, allowCached: boolean): void {
    const file = this.archived(asset.archivePath);
    if (!file.exists || file.size !== asset.byteLength) {
      throw new Error(`Canonical Pulse media is missing or damaged: ${asset.path}`);
    }
    const fingerprint = this.fingerprint(file);
    const cached = this.verifiedCanonical.get(asset.archivePath);
    // Warm saves assume app-owned canonical files are immutable. A size/mtime change
    // forces hashing; absent metadata disables reuse. Same-size, same-mtime out-of-band
    // tampering is detected by the mandatory full hash on the next load, not this cache.
    if (
      !allowCached ||
      fingerprint === null ||
      cached?.fingerprint !== fingerprint ||
      cached.sha256 !== asset.sha256
    ) {
      if (hashPulseFile(file) !== asset.sha256) {
        throw new Error(`Canonical Pulse media is missing or damaged: ${asset.path}`);
      }
    }
    this.verifiedCanonical.set(asset.archivePath, { fingerprint, sha256: asset.sha256 });
  }

  materializeAssets(assets: readonly PulseAsset[]): void {
    for (const asset of assets) {
      const target = this.local(asset.path);
      if (
        target.exists &&
        target.size === asset.byteLength &&
        this.sourceHash(asset.path, target) === asset.sha256
      ) {
        continue;
      }
      target.parentDirectory.create({ intermediates: true, idempotent: true });
      this.archived(asset.archivePath).copySync(target, { overwrite: true });
      this.fingerprints.set(asset.path, {
        fingerprint: this.fingerprint(target),
        sha256: asset.sha256,
      });
    }
  }
}
