// @ts-check
// The one place the packaging script changes anything: tool calls (ditto, dsymutil, lipo, strip,
// otool, plutil) and file writes. With `dryRun` it prints each one as a shell line instead, so
// `--dry-run` shows the whole plan and writes nothing.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** @param {string} arg */
export function shellQuote(arg) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** @param {string} cmd @param {readonly string[]} args */
export function commandLine(cmd, args) {
  return [cmd, ...args].map(shellQuote).join(' ');
}

/**
 * @param {{ dryRun: boolean, log?: (line: string) => void,
 *   exec?: (cmd: string, args: readonly string[]) => string }} options
 *   `exec` runs a tool and returns its stdout; tests pass a fake.
 */
export function createRunner({ dryRun, log = (line) => console.log(line), exec }) {
  const execTool =
    exec ??
    ((cmd, args) =>
      execFileSync(cmd, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        maxBuffer: 1 << 26,
      }));
  /** @type {string[]} */
  const plan = [];
  const note = (/** @type {string} */ line) => {
    plan.push(line);
    log(dryRun ? line : `+ ${line}`);
  };

  return {
    dryRun,
    /** Every line run or planned, in order. */
    plan,
    /** A heading in the printed plan. */
    step(/** @type {string} */ title) {
      log(`\n# ${title}`);
    },
    /**
     * Runs a tool that changes files (or prints it). Returns stdout, or '' in a dry run.
     * @param {string} cmd @param {readonly string[]} args
     */
    run(cmd, args) {
      note(commandLine(cmd, args));
      return dryRun ? '' : execTool(cmd, args);
    },
    /**
     * Runs a read-only tool on a file the run produced. In a dry run that file doesn't exist,
     * so the call is printed and `null` comes back.
     * @param {string} cmd @param {readonly string[]} args
     * @returns {string | null}
     */
    inspect(cmd, args) {
      note(commandLine(cmd, args));
      return dryRun ? null : execTool(cmd, args);
    },
    /** @param {string} dir */
    mkdir(dir) {
      note(commandLine('mkdir', ['-p', dir]));
      if (!dryRun) fs.mkdirSync(dir, { recursive: true });
    },
    /** @param {string} target */
    remove(target) {
      note(commandLine('rm', ['-rf', target]));
      if (!dryRun) fs.rmSync(target, { recursive: true, force: true });
    },
    /**
     * Writes a file the script generated. `summary` says what goes in it, for the printed plan.
     * @param {string} file @param {string} contents @param {string} summary
     */
    writeFile(file, contents, summary) {
      note(`# write ${file} (${summary})`);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, contents);
      }
    },
  };
}

/** @typedef {ReturnType<typeof createRunner>} Runner */
