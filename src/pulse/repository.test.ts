import { describe, expect, it } from '@jest/globals';

import { emptyPulseState, stringifyPulseYaml, type PulseDocument } from './document';
import { PulseRepository, PulseRevisionConflictError, type PulseStorage } from './repository';

function fixture() {
  const commits: { revision: number; yaml: string }[] = [];
  const storage: PulseStorage = {
    readCommits: () => commits.map((entry) => ({ ...entry })),
    publish: (document, yaml, generation = document.revision) => {
      commits.push({ revision: generation, yaml });
    },
    captureAssets: () => [],
    verifyAssets: () => {},
    materializeAssets: () => {},
  };
  return { commits, storage, repository: new PulseRepository(storage) };
}

describe('canonical Pulse repository', () => {
  it('reopens exactly the YAML object and preserves unknown setting values and nulls', () => {
    const { repository, storage } = fixture();
    expect(repository.load()).toBeNull();
    const state = emptyPulseState();
    state.settings.push({ key: 'old.unknown', value: 'λ\n: false' }, { key: 'null', value: null });
    const saved = repository.commit(state);
    const reopened = new PulseRepository(storage);
    expect(reopened.load()).toEqual(saved);
    expect(reopened.commit(saved.state)).toEqual(saved);
  });

  it('never reports a failed canonical write as saved', () => {
    const { repository, storage } = fixture();
    repository.load();
    const before = repository.commit(emptyPulseState());
    storage.publish = () => {
      throw new Error('disk full');
    };
    const next = emptyPulseState();
    next.settings.push({ key: 'theme', value: 'dark' });
    expect(() => repository.commit(next)).toThrow('disk full');
    expect(repository.getDocument()).toEqual(before);
    expect(new PulseRepository(storage).load()).toEqual(before);
  });

  it('does not silently fall back when the latest committed revision is corrupt', () => {
    const { repository, storage, commits } = fixture();
    repository.load();
    repository.commit(emptyPulseState());
    commits.push({ revision: 2, yaml: 'not a Pulse document' });
    expect(() => new PulseRepository(storage).load()).toThrow();
  });

  it('checks required assets before hydration and leaves a failed recovery uninitialized', () => {
    const { repository, storage } = fixture();
    repository.load();
    repository.commit(emptyPulseState());
    storage.verifyAssets = () => {
      throw new Error('missing source');
    };
    const reopened = new PulseRepository(storage);
    expect(() => reopened.load()).toThrow('missing source');
    expect(() => reopened.commit(emptyPulseState())).toThrow('not been initialized');
  });

  it('returns isolated snapshots so callers cannot mutate the source of truth', () => {
    const { repository } = fixture();
    repository.load();
    const saved = repository.commit(emptyPulseState());
    saved.state.settings.push({ key: 'not committed', value: 'x' });
    expect(repository.getDocument()?.state.settings).toEqual([]);
  });

  it('rejects conflicting publication identities and invalid generations', () => {
    const { repository, storage, commits } = fixture();
    repository.load();
    const doc = repository.commit(emptyPulseState());
    const other: PulseDocument = {
      ...doc,
      state: { ...doc.state, settings: [{ key: 'x', value: 'y' }] },
    };
    commits.push({ revision: 1, yaml: stringifyPulseYaml(other) });
    expect(() => new PulseRepository(storage).load()).toThrow('Conflicting');
    commits.pop();
    commits[0].revision = -1;
    expect(() => new PulseRepository(storage).load()).toThrow('Invalid canonical');
  });

  it('restores a historical YAML revision exactly as the latest publication', () => {
    const { repository, storage } = fixture();
    repository.load();
    const historical = repository.commit(emptyPulseState());
    const changed = emptyPulseState();
    changed.settings.push({ key: 'later', value: 'state' });
    expect(repository.commit(changed).revision).toBe(2);
    expect(repository.restore(historical)).toEqual(historical);
    expect(new PulseRepository(storage).load()).toEqual(historical);
  });

  it('rejects stale edits and restores before staging assets or publishing', () => {
    const { repository, commits, storage } = fixture();
    repository.load();
    const saved = repository.commit(emptyPulseState());
    const changed = emptyPulseState();
    changed.settings.push({ key: 'new', value: 'kept' });
    repository.commit(changed, undefined, saved.revision);
    storage.captureAssets = () => {
      throw new Error('must not stage');
    };
    storage.importAssets = () => {
      throw new Error('must not restore assets');
    };
    expect(() => repository.commit(saved.state, undefined, saved.revision)).toThrow(
      PulseRevisionConflictError,
    );
    expect(() => repository.restore(saved, saved.revision)).toThrow(PulseRevisionConflictError);
    expect(commits).toHaveLength(2);
    expect(repository.getDocument()?.state).toEqual(changed);
  });

  it('detects stale writers even when exact restore repeats a historical document revision', () => {
    const { repository } = fixture();
    repository.load();
    const doc = repository.commit(emptyPulseState());
    const token = repository.getPublicationGeneration();
    repository.restore(doc, token);
    expect(repository.getDocument()?.revision).toBe(doc.revision);
    expect(repository.getPublicationGeneration()).toBe(token + 1);
    expect(() => repository.restore(doc, token)).toThrow(PulseRevisionConflictError);
    expect(() => repository.commit(doc.state, undefined, token)).toThrow(
      PulseRevisionConflictError,
    );
  });
});
