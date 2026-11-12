import {
  parsePulseYaml,
  stringifyPulseYaml,
  validatePulseDocument,
  type PulseAsset,
  type PulseDocument,
  type PulseState,
} from './document';

/** Synchronous because the existing native SQLite transaction API is synchronous. */
export interface PulseStorage {
  readCommits(): { revision: number; yaml: string }[];
  publish(document: PulseDocument, yaml: string, generation?: number): void;
  captureAssets(state: PulseState, previous: readonly PulseAsset[]): PulseAsset[];
  verifyAssets(assets: readonly PulseAsset[]): void;
  materializeAssets(assets: readonly PulseAsset[]): void;
  importAssets?(assets: readonly PulseAsset[], incoming?: ReadonlyMap<string, Uint8Array>): void;
  prepareInitialMigration?(): void;
  finishInitialMigration?(): void;
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class PulseRevisionConflictError extends Error {
  constructor(
    readonly expectedGeneration: number,
    readonly actualGeneration: number,
  ) {
    super(`Pulse publication changed (expected ${expectedGeneration}, found ${actualGeneration}).`);
    this.name = 'PulseRevisionConflictError';
  }
}

/** The in-memory Pulse object is identical whether loaded from YAML or staged from SQLite. */
export class PulseRepository {
  private current: PulseDocument | null = null;
  private loaded = false;
  private generation = 0;

  constructor(private readonly storage: PulseStorage) {}

  load(): PulseDocument | null {
    this.loaded = false;
    this.current = null;
    this.generation = 0;
    const commits = this.storage.readCommits().sort((a, b) => b.revision - a.revision);
    if (
      commits.length > 1 &&
      commits[0].revision === commits[1].revision &&
      commits[0].yaml !== commits[1].yaml
    ) {
      throw new Error('Conflicting canonical Pulse revisions. Recovery is required.');
    }
    const latest = commits[0];
    if (latest) {
      const document = parsePulseYaml(latest.yaml);
      if (
        document.scope !== 'library' ||
        !Number.isSafeInteger(latest.revision) ||
        latest.revision < 1
      ) {
        throw new Error('Invalid canonical Pulse library commit.');
      }
      // A corrupt committed latest revision is an error, never a silent rollback of a saved edit.
      this.storage.verifyAssets(document.assets);
      this.current = document;
      this.generation = latest.revision;
    }
    this.loaded = true;
    return this.getDocument();
  }

  getDocument(): PulseDocument | null {
    return this.current ? copy(this.current) : null;
  }

  /** Monotonic compare-and-save token, including exact restores of historical revisions. */
  getPublicationGeneration(): number {
    if (!this.loaded) throw new Error('Canonical Pulse storage has not been initialized.');
    return this.generation;
  }

  beginInitialMigration(): void {
    if (!this.loaded || this.current)
      throw new Error('Only an unseeded Pulse store can begin migration.');
    this.storage.prepareInitialMigration?.();
  }

  finishInitialMigration(): void {
    if (!this.current)
      throw new Error('A committed Pulse document is required to finish migration.');
    this.storage.finishInitialMigration?.();
  }

  materialize(): void {
    if (!this.loaded) throw new Error('Load canonical Pulse storage before rebuilding its index.');
    if (this.current) this.storage.materializeAssets(this.current.assets);
  }

  commit(
    state: PulseState,
    beforePublish?: (document: PulseDocument) => void,
    expectedGeneration?: number,
  ): PulseDocument {
    if (!this.loaded) throw new Error('Canonical Pulse storage has not been initialized.');
    this.checkGeneration(expectedGeneration);
    const stableState = copy(state);
    if (this.current && JSON.stringify(this.current.state) === JSON.stringify(stableState)) {
      beforePublish?.(copy(this.current));
      return copy(this.current);
    }
    const document: PulseDocument = {
      format: 'pulse-document',
      version: 2,
      scope: 'library',
      revision: (this.current?.revision ?? 0) + 1,
      state: stableState,
      assets: this.storage.captureAssets(stableState, this.current?.assets ?? []),
    };
    validatePulseDocument(document);
    const yaml = stringifyPulseYaml(document);
    // A database adapter can stage this header in its uncommitted projection transaction.
    beforePublish?.(copy(document));
    // publish is the commit point. A later SQLite failure cannot revoke this saved revision.
    this.storage.publish(document, yaml, this.generation + 1);
    this.generation++;
    this.current = document;
    return copy(document);
  }

  /** Exact library restore retains the YAML object's revision, scope, descriptors and ordering. */
  restore(
    document: PulseDocument,
    expectedGeneration?: number,
    incoming?: ReadonlyMap<string, Uint8Array>,
  ): PulseDocument {
    if (!this.loaded) throw new Error('Canonical Pulse storage has not been initialized.');
    this.checkGeneration(expectedGeneration);
    validatePulseDocument(document);
    if (document.scope !== 'library')
      throw new Error('Exact restore requires a library Pulse document.');
    const stable = copy(document);
    if (stable.assets.length) {
      if (!this.storage.importAssets)
        throw new Error('This store does not support exact asset restore.');
      this.storage.importAssets(stable.assets, incoming);
    }
    this.storage.verifyAssets(stable.assets);
    // Publication order is separate from the restored document's historical revision.
    this.storage.publish(stable, stringifyPulseYaml(stable), this.generation + 1);
    this.generation++;
    this.current = stable;
    return copy(stable);
  }

  private checkGeneration(expected: number | undefined): void {
    if (expected !== undefined && expected !== this.generation) {
      throw new PulseRevisionConflictError(expected, this.generation);
    }
  }
}
