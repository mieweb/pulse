import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertSafeOut,
  foreignOutEntries,
  isSameOrInside,
  outDirProblems,
  realPath,
} from './out-dir.mjs';

const script = path.resolve(__dirname, '../package-ios.mjs');
const fixture = path.join(__dirname, '__fixtures__', 'fake-build');

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-out-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isSameOrInside', () => {
  it('compares whole path segments', () => {
    expect(isSameOrInside('/a/b', '/a/b')).toBe(true);
    expect(isSameOrInside('/a/b', '/a/b/c/d')).toBe(true);
    expect(isSameOrInside('/a/b', '/a/bc')).toBe(false);
    expect(isSameOrInside('/a/b', '/a')).toBe(false);
    expect(isSameOrInside('/a/b', '/a/..b')).toBe(false);
    expect(isSameOrInside('/a/b', '/a/b/..c')).toBe(true);
  });
});

describe('realPath', () => {
  it('resolves links in the part that exists and keeps the rest', () => {
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
    expect(realPath(path.join(root, 'link', 'not', 'yet'))).toBe(
      path.join(fs.realpathSync(root), 'real', 'not', 'yet'),
    );
  });
});

describe('outDirProblems', () => {
  const repo = '/r';
  const input = '/r/embed/artifacts';
  const guarded = [
    { path: input, label: '--input', allowInside: true },
    { path: repo, label: 'the repo', allowInside: true },
    { path: '/r/.git', label: "the repo's .git" },
    { path: '/r/embed/artifacts/PulseKit.xcframework', label: 'the input PulseKit.xcframework' },
    {
      path: '/r/node_modules/whisper.rn/ios/rnwhisper.xcframework',
      label: 'the input rnwhisper.xcframework',
    },
  ];

  it('allows the default --out and folders elsewhere', () => {
    expect(outDirProblems('/r/embed/artifacts/pulsekit-ios', guarded)).toEqual([]);
    expect(outDirProblems('/elsewhere/pk-out', guarded)).toEqual([]);
    expect(outDirProblems('/r/embed/artifactsX', guarded)).toEqual([]);
  });

  it('refuses --out equal to --input (the --out embed/artifacts --clean typo)', () => {
    expect(outDirProblems(input, guarded)).toEqual([
      `--out ${input} is --input (${input})`,
      `--out ${input} contains the input PulseKit.xcframework (/r/embed/artifacts/PulseKit.xcframework)`,
    ]);
  });

  it('refuses the repo root and anything above it', () => {
    for (const out of ['/r', '/', '/r/embed/..']) {
      expect(outDirProblems(out, guarded).join('\n')).toMatch(/is the repo|contains the repo/);
    }
  });

  it('refuses a folder holding a vendored framework, or inside an input xcframework or .git', () => {
    expect(outDirProblems('/r/node_modules/whisper.rn', guarded)).toEqual([
      '--out /r/node_modules/whisper.rn contains the input rnwhisper.xcframework (/r/node_modules/whisper.rn/ios/rnwhisper.xcframework)',
    ]);
    expect(outDirProblems('/r/embed/artifacts/PulseKit.xcframework/x', guarded)).toEqual([
      '--out /r/embed/artifacts/PulseKit.xcframework/x is inside the input PulseKit.xcframework (/r/embed/artifacts/PulseKit.xcframework)',
    ]);
    expect(outDirProblems('/r/.git/pk', guarded)).toEqual([
      "--out /r/.git/pk is inside the repo's .git (/r/.git)",
    ]);
  });

  it('sees through a symlink to the input', () => {
    fs.mkdirSync(path.join(root, 'in'));
    fs.symlinkSync(path.join(root, 'in'), path.join(root, 'alias'));
    expect(() =>
      assertSafeOut(path.join(root, 'alias'), [
        { path: path.join(root, 'in'), label: '--input', allowInside: true },
      ]),
    ).toThrow('is --input');
  });
});

describe('foreignOutEntries', () => {
  it("lists what an earlier run didn't write", () => {
    expect(foreignOutEntries(['release', 'dSYMs', 'xcframeworks', '.DS_Store'])).toEqual([]);
    expect(foreignOutEntries(['xcframeworks', 'PulseKit.xcframework', '.git', 'README'])).toEqual([
      '.git',
      'PulseKit.xcframework',
      'README',
    ]);
  });
});

describe('package-ios.mjs --out guard', () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [script, ...args, '--build', '7', '--git-sha', 'abcdef1'], {
      encoding: 'utf8',
    });

  it('refuses --out = --input with --clean and deletes nothing', () => {
    const input = path.join(root, 'in');
    fs.cpSync(fixture, input, { recursive: true });
    const before = fs.readdirSync(input).sort();

    const result = run(['--input', input, '--out', input, '--clean']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to write there');
    expect(result.stderr).toContain('is --input');
    expect(fs.readdirSync(input).sort()).toEqual(before);
    expect(
      fs.existsSync(path.join(input, 'PulseKit.xcframework', 'ios-arm64', 'PulseKit.framework')),
    ).toBe(true);
  });

  it('refuses --clean on a folder an earlier run did not write', () => {
    const out = path.join(root, 'out');
    fs.mkdirSync(path.join(out, 'xcframeworks'), { recursive: true });
    fs.writeFileSync(path.join(out, 'notes.txt'), 'keep me');

    const result = run(['--input', fixture, '--out', out, '--clean', '--dry-run']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('also holds: notes.txt');
    expect(fs.readFileSync(path.join(out, 'notes.txt'), 'utf8')).toBe('keep me');
  });
});
