/** Git summaries bundled by app.config.ts, scoped to the installed build. */
export type ReleaseNote = {
  version: string;
  /** ISO calendar date of the release commit; no time-zone conversion. */
  date: string | null;
  notes: string[];
};

export type ReleaseNotes = {
  current: ReleaseNote | null;
  history: ReleaseNote[];
};

export type ReleaseNotesConfig = {
  version?: string;
  extra?: { releaseNotes?: ReleaseNotes };
};

/** Old builds/source archives have no notes. Never label another version's notes as this build. */
export function readReleaseNotes(config: ReleaseNotesConfig | null | undefined): ReleaseNotes {
  const notes = config?.extra?.releaseNotes;
  return {
    current: notes?.current?.version === config?.version ? (notes?.current ?? null) : null,
    history: notes?.history ?? [],
  };
}

export function releaseDateLabel(date: string | null): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
