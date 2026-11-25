import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import childProcess, { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectReleaseNotes } from '../../../scripts/release-notes';

let root: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commit(subject: string): string {
  git('commit', '--allow-empty', '-m', subject);
  return git('rev-parse', 'HEAD');
}

function tag(version: string) {
  git('tag', `app-v${version}`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pulse-release-notes-'));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'ignore' });
  git('config', 'user.name', 'Release notes test');
  git('config', 'user.email', 'release-notes@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('build-time release notes', () => {
  it('includes the installed version through its exact build commit and five adjacent releases', () => {
    for (let i = 0; i < 7; i++) {
      commit(`feat: Release feature ${i}`);
      tag(`1.0.${i}`);
    }
    commit('feat(recorder): Record screen clips');
    tag('2.0.0');
    const builtCommit = commit('fix(editor): Keep the playhead after inserting a clip');
    // A higher-version tag and a newer checkout commit must not change this build's notes.
    tag('3.0.0');
    commit('feat: A change after the build');
    git('tag', 'pulsekit-v4.0.0');
    git('checkout', '--orphan', 'unrelated');
    commit('feat: Unrelated app feature');
    tag('1.9.0');
    git('checkout', 'main');

    const result = collectReleaseNotes({ version: '2.0.0', commit: builtCommit, cwd: repo });
    expect(result.current).toEqual({
      version: '2.0.0',
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      notes: ['Keep the playhead after inserting a clip', 'Record screen clips'],
    });
    expect(result.history.map((entry) => entry.version)).toEqual([
      '1.0.6',
      '1.0.5',
      '1.0.4',
      '1.0.3',
      '1.0.2',
    ]);
    expect(result.history.map((entry) => entry.notes)).toEqual(
      [6, 5, 4, 3, 2].map((i) => [`Release feature ${i}`]),
    );
  });

  it('uses PR summaries and meaningful branch titles when a merge has no body', () => {
    commit('feat: Initial app');
    tag('1.0.0');
    git('checkout', '-b', 'insert');
    commit('fix(editor): Keep previous undo entries');
    commit('feat(editor): Insert clips at the playhead');
    commit('docs: Document the insert design');
    git('checkout', 'main');
    git('merge', '--no-ff', 'insert', '-m', 'Merge pull request #12 from team/insert');
    git('checkout', '-b', 'screen');
    commit('feat: Internal recorder implementation');
    git('checkout', 'main');
    git(
      'merge',
      '--no-ff',
      'screen',
      '-m',
      'Merge pull request #13 from team/screen',
      '-m',
      'feat(recorder): Record your screen as a clip',
    );
    commit('fix(export): Preserve audio when sharing (#14)');
    commit('fix(export): Preserve audio when sharing (#15)');
    commit('chore(release): 1.1.0');
    commit('ci: Archive and upload the app');
    commit('docs: Update the guide');

    expect(collectReleaseNotes({ version: '1.1.0', cwd: repo }).current?.notes).toEqual([
      'Preserve audio when sharing',
      'Record your screen as a clip',
      'Insert clips at the playhead',
    ]);
  });

  it('never labels the full repository log as a release when a boundary is missing', () => {
    commit('feat: Ancient repository work');
    expect(collectReleaseNotes({ version: '1.0.0', cwd: repo })).toEqual({
      current: null,
      history: [],
    });
    tag('1.0.0');
    commit('feat: A new feature');
    tag('1.1.0');
    const result = collectReleaseNotes({ version: '1.1.0', cwd: repo });
    expect(result.current?.notes).toEqual(['A new feature']);
    expect(result.history).toEqual([]);
  });

  it('returns unavailable notes for shallow clones rather than publishing truncated changes', () => {
    commit('feat: Initial app');
    tag('1.0.0');
    commit('feat: A recent change');
    tag('1.1.0');
    const shallow = join(root, 'shallow');
    execFileSync('git', ['clone', '--depth=1', `file://${repo}`, shallow], { stdio: 'ignore' });
    expect(collectReleaseNotes({ version: '1.1.0', cwd: shallow })).toEqual({
      current: null,
      history: [],
    });
  });

  it('degrades safely without Git, a checkout, or a valid build commit', () => {
    expect(collectReleaseNotes({ version: '1.0.0', cwd: root })).toEqual({
      current: null,
      history: [],
    });
    commit('feat: Initial app');
    tag('1.0.0');
    expect(collectReleaseNotes({ version: '1.1.0', commit: 'not-a-commit', cwd: repo })).toEqual({
      current: null,
      history: [],
    });
    const missingGit = jest.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' });
    });
    try {
      expect(collectReleaseNotes({ version: '1.1.0', cwd: repo })).toEqual({
        current: null,
        history: [],
      });
    } finally {
      missingGit.mockRestore();
    }
  });
});

describe('explicit local test-build notes', () => {
  const testNote = {
    version: '1.2.0',
    date: '2026-11-25',
    notes: ['Try Home + → Blank project. The recorder should open immediately.'],
  };

  it('includes uncommitted test instructions while retaining release history and ordinary builds', () => {
    commit('feat: First release');
    tag('1.0.0');
    commit('feat: Earlier feature');
    tag('1.1.0');
    commit('feat: Committed work');
    const ordinary = collectReleaseNotes({ version: '1.2.0', cwd: repo });
    writeFileSync(join(repo, 'test-notes.json'), JSON.stringify(testNote));

    const local = collectReleaseNotes({
      version: '1.2.0',
      cwd: repo,
      testNotesFile: 'test-notes.json',
    });
    expect(local.current).toEqual(testNote);
    expect(local.history).toEqual(ordinary.history);
    expect(local.history).toHaveLength(1);
    expect(collectReleaseNotes({ version: '1.2.0', cwd: repo })).toEqual(ordinary);
    expect(git('status', '--porcelain')).toContain('?? test-notes.json');
  });

  it('can supply local test instructions when Git release history is unavailable', () => {
    writeFileSync(join(root, 'test-notes.json'), JSON.stringify(testNote));
    expect(
      collectReleaseNotes({ version: '1.2.0', cwd: root, testNotesFile: 'test-notes.json' }),
    ).toEqual({ current: testNote, history: [] });
  });

  it('rejects wrong-version, invalid-date and empty test instructions', () => {
    for (const invalid of [
      { ...testNote, version: '1.1.0' },
      { ...testNote, date: '2026-02-30' },
      { ...testNote, date: null },
      { ...testNote, notes: [] },
      { ...testNote, notes: [' '] },
      { ...testNote, notes: [42] },
      null,
    ]) {
      writeFileSync(join(repo, 'test-notes.json'), JSON.stringify(invalid));
      expect(() =>
        collectReleaseNotes({ version: '1.2.0', cwd: repo, testNotesFile: 'test-notes.json' }),
      ).toThrow(/Invalid test release notes/);
    }
  });

  it('fails clearly when an explicitly requested file is missing or malformed', () => {
    const read = () =>
      collectReleaseNotes({ version: '1.2.0', cwd: repo, testNotesFile: 'test-notes.json' });
    expect(read).toThrow(/Could not read test release notes/);
    writeFileSync(join(repo, 'test-notes.json'), '{unfinished JSON');
    expect(read).toThrow(/Could not read test release notes/);
  });
});
