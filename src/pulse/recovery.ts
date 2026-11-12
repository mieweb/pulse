import type { PulseDocument } from './document';
import { LEGACY_UPGRADE_PENDING_KEY } from './bootstrap';
import type { PulseRepository } from './repository';
import { readPulseState, replacePulseDocument, type PulseSqliteDatabase } from './sqlite-state';

/** Called with application writes disabled, after schema creation and before any cleanup/jobs. */
export function hydratePulseIndex(
  repository: PulseRepository,
  database: PulseSqliteDatabase,
): PulseDocument {
  const canonical = repository.getDocument();
  if (canonical) {
    repository.materialize();
    replacePulseDocument(database, canonical);
    repository.finishInitialMigration();
    return canonical;
  }
  // First upgrade: the retained legacy database seeds a complete canonical revision.
  // No old rows or files are removed before this publication succeeds.
  const state = readPulseState(database);
  state.settings = [
    ...state.settings.filter((row) => row.key !== LEGACY_UPGRADE_PENDING_KEY),
    { key: LEGACY_UPGRADE_PENDING_KEY, value: 'true' },
  ];
  repository.beginInitialMigration();
  const document = repository.commit(state);
  replacePulseDocument(database, document);
  repository.finishInitialMigration();
  return document;
}
