import { execFileSync } from 'node:child_process';

import type { ReleaseNote, ReleaseNotes } from '../src/features/about/release-notes';

type Options = {
  version: string;
  commit?: string;
  /** Defaults to the checkout Expo is building; explicit for isolated repository tests. */
  cwd?: string;
};

type ReleaseTag = { ref: string; version: string; parts: number[] };
type Change = { hash: string; parents: string[]; subject: string; body: string };

const HISTORY_COUNT = 5;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const MERGE = /^Merge (?:pull request|branch|remote-tracking branch|tag)\b/i;
const MAINTENANCE = /^(?:build|chore|ci|docs|test|style|refactor)(?:\([^)]*\))?!?:/i;

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** A short PR/commit title, without Git plumbing or conventional-commit bookkeeping. */
function noteTitle(subject: string): string | null {
  const title = subject.trim();
  if (
    !title ||
    MERGE.test(title) ||
    MAINTENANCE.test(title) ||
    /^(?:fix|feat)\((?:release|ci|deps|lint)\)!?:/i.test(title) ||
    /\b(?:agent|copilot|contributor|repository) instructions\b/i.test(title)
  ) {
    return null;
  }
  const clean = title
    .replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '')
    .replace(/\s+\(#\d+\)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean[0].toUpperCase() + clean.slice(1) : null;
}

/**
 * Release notes are generated while Expo reads its config, then shipped with that build. Only
 * app-vX.Y.Z release boundaries reachable from that exact commit are used; PulseKit tags and
 * releases on another branch cannot enter this app's history. Missing Git, tags or complete
 * history means unavailable notes, rather than presenting the whole repository log as a release.
 */
export function collectReleaseNotes({ version, commit = 'HEAD', cwd }: Options): ReleaseNotes {
  const unavailable: ReleaseNotes = { current: null, history: [] };
  const versionMatch = VERSION.exec(version);
  if (!versionMatch) return unavailable;
  const parts = versionMatch.slice(1).map(Number);

  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    }).trim();

  try {
    // Even a visible tag can sit at a shallow boundary. Never silently call a truncated log a
    // complete release. Store build workflows fetch full history before evaluating this config.
    if (git('rev-parse', '--is-shallow-repository') !== 'false') return unavailable;
    const head = git('rev-parse', '--verify', '--end-of-options', `${commit}^{commit}`);
    const tags: ReleaseTag[] = git('tag', '--list', 'app-v*', '--merged', head)
      .split('\n')
      .flatMap((ref) => {
        const match = VERSION.exec(ref.slice('app-v'.length));
        if (!match) return [];
        const tagParts = match.slice(1).map(Number);
        // A build of 2.7.0 includes all changes since 2.6.0, even after 2.7.0 was tagged. A
        // future-version tag cannot become the baseline for an older configured app version.
        return compareVersions(tagParts, parts) < 0
          ? [{ ref, version: ref.slice('app-v'.length), parts: tagParts }]
          : [];
      })
      .sort((a, b) => compareVersions(b.parts, a.parts));
    if (tags.length === 0) return unavailable;

    const readChanges = (range: string): Change[] => {
      const fields = git(
        'log',
        '--first-parent',
        '--format=%H%x00%P%x00%s%x00%b%x00',
        range,
        '--',
      ).split('\0');
      const changes: Change[] = [];
      for (let i = 0; i + 3 < fields.length; i += 4) {
        changes.push({
          hash: fields[i].trim(),
          parents: fields[i + 1].trim().split(/\s+/).filter(Boolean),
          subject: fields[i + 2],
          body: fields[i + 3],
        });
      }
      return changes;
    };

    const changeTitle = (change: Change): string | null => {
      if (!MERGE.test(change.subject)) return noteTitle(change.subject);
      const summary = change.body.split('\n').find((line) => line.trim());
      if (summary) return noteTitle(summary);
      if (change.parents.length !== 2) return null;
      // Some GitHub merges have no PR title/body. Use a meaningful title from that branch,
      // favoring its feature over follow-up fixes. Never show "Merge pull request…" as a note.
      const subjects = git(
        'log',
        '--reverse',
        '--no-merges',
        '--format=%s',
        `${change.parents[0]}..${change.parents[1]}`,
        '--',
      )
        .split('\n')
        .filter((subject) => noteTitle(subject));
      const primary = subjects.find((subject) => /^feat(?:\([^)]*\))?!?:/i.test(subject));
      return noteTitle(primary ?? subjects[0] ?? '');
    };

    const release = (releaseVersion: string, end: string, base: string): ReleaseNote | null => {
      try {
        // Semver sorting does not prove ancestry (for example, a backported patch). Don't
        // subtract a different branch's history and assign the result to this release.
        git('merge-base', '--is-ancestor', base, end);
        const notes = readChanges(`${base}..${end}`)
          .map(changeTitle)
          .filter((note): note is string => note !== null);
        const unique = new Map(notes.map((note) => [note.toLocaleLowerCase('en'), note]));
        const date = git('show', '-s', '--format=%cs', `${end}^{commit}`);
        return { version: releaseVersion, date: date || null, notes: [...unique.values()] };
      } catch {
        return null;
      }
    };

    return {
      current: release(version, head, tags[0].ref),
      // The oldest known tag has no known lower boundary, so leave it out rather than label
      // all earlier repository work as that version's release notes.
      history: tags.slice(0, HISTORY_COUNT).flatMap((tag, index) => {
        const base = tags[index + 1];
        const entry = base && release(tag.version, tag.ref, base.ref);
        return entry ? [entry] : [];
      }),
    };
  } catch {
    return unavailable;
  }
}
