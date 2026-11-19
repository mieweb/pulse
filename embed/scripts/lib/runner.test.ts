import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commandLine, createRunner } from './runner.mjs';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-runner-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeExec() {
  const calls: string[] = [];
  return {
    calls,
    exec: (cmd: string, args: readonly string[]) => {
      calls.push(commandLine(cmd, args));
      return 'stdout';
    },
  };
}

describe('createRunner', () => {
  it('in a dry run prints every step and runs and writes nothing', () => {
    const lines: string[] = [];
    const { calls, exec } = fakeExec();
    const runner = createRunner({ dryRun: true, log: (l) => lines.push(l), exec });
    const out = path.join(dir, 'out');

    expect(runner.run('strip', ['-x', `${out}/My App.framework/My App`])).toBe('');
    expect(runner.inspect('otool', ['-L', 'bin'])).toBeNull();
    runner.mkdir(out);
    runner.writeFile(path.join(out, 'SHA256SUMS'), 'x', '2 zips');
    runner.remove(dir);

    expect(calls).toEqual([]);
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
    expect(lines).toEqual([
      `strip -x '${out}/My App.framework/My App'`,
      'otool -L bin',
      `mkdir -p ${out}`,
      `# write ${out}/SHA256SUMS (2 zips)`,
      `rm -rf ${dir}`,
    ]);
    expect(runner.plan).toEqual(lines);
  });

  it('for real runs the tools and writes the files', () => {
    const lines: string[] = [];
    const { calls, exec } = fakeExec();
    const runner = createRunner({ dryRun: false, log: (l) => lines.push(l), exec });
    const file = path.join(dir, 'a', 'b', 'SHA256SUMS');

    expect(runner.run('ditto', ['src', 'dst'])).toBe('stdout');
    expect(runner.inspect('lipo', ['bin', '-verify_arch', 'arm64'])).toBe('stdout');
    runner.writeFile(file, 'sums\n', 'sums');
    expect(fs.readFileSync(file, 'utf8')).toBe('sums\n');
    runner.remove(path.join(dir, 'a'));
    expect(fs.existsSync(path.join(dir, 'a'))).toBe(false);

    expect(calls).toEqual(['ditto src dst', 'lipo bin -verify_arch arm64']);
    expect(lines[0]).toBe('+ ditto src dst');
  });

  it('quotes arguments the shell would split', () => {
    expect(commandLine('ditto', ["it's here", 'plain/path-1.0'])).toBe(
      `ditto 'it'\\''s here' plain/path-1.0`,
    );
  });
});
