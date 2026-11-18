// @ts-check
// Where the packaging script may write. `--clean` deletes --out, and the default --out sits inside
// the default --input, so a typo like `--out embed/artifacts --clean` would delete the native build
// (and `--out .` the whole checkout). The script refuses those before it touches anything.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} GuardedPath
 * @property {string} path    A folder the run must not delete or write into.
 * @property {string} label   What it is, for the error (for example "--input").
 * @property {boolean} [allowInside]  True when --out may sit inside it (the default --out sits
 *   inside --input); --out still may not be it or contain it.
 */

/**
 * The path with symlinks resolved as far as it exists, so `/tmp/x` and `/private/tmp/x` compare
 * equal on macOS even when `x` doesn't exist yet.
 * @param {string} p
 */
export function realPath(p) {
  let head = path.resolve(p);
  /** @type {string[]} */
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...rest);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Whether `child` is `parent` or somewhere under it. Both are absolute.
 * @param {string} parent @param {string} child
 */
export function isSameOrInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Why `out` is not a safe output folder: it is a guarded folder, contains one (so deleting it
 * deletes that too), or sits inside one that doesn't allow it. Empty when it's safe.
 * @param {string} out
 * @param {readonly GuardedPath[]} guarded
 * @returns {string[]}
 */
export function outDirProblems(out, guarded) {
  const target = realPath(out);
  /** @type {string[]} */
  const problems = [];
  for (const g of guarded) {
    const kept = realPath(g.path);
    if (target === kept) problems.push(`--out ${out} is ${g.label} (${g.path})`);
    else if (isSameOrInside(target, kept)) {
      problems.push(`--out ${out} contains ${g.label} (${g.path})`);
    } else if (!g.allowInside && isSameOrInside(kept, target)) {
      problems.push(`--out ${out} is inside ${g.label} (${g.path})`);
    }
  }
  return problems;
}

/**
 * Throws when `out` is not a safe output folder (see `outDirProblems`).
 * @param {string} out
 * @param {readonly GuardedPath[]} guarded
 */
export function assertSafeOut(out, guarded) {
  const problems = outDirProblems(out, guarded);
  if (problems.length > 0) {
    throw new Error(`Refusing to write there:\n  ${problems.join('\n  ')}`);
  }
}

/** The folders a run writes into --out; `--clean` only deletes a folder that holds just these. */
export const OUT_ENTRIES = /** @type {const} */ (['xcframeworks', 'dSYMs', 'release']);

/**
 * The entries of an existing --out that a previous run didn't write, sorted. `--clean` refuses
 * when there are any, so it can only ever delete an earlier run's output.
 * @param {readonly string[]} entries  `fs.readdirSync(out)`
 */
export function foreignOutEntries(entries) {
  /** @type {readonly string[]} */
  const ours = [...OUT_ENTRIES, '.DS_Store'];
  return entries.filter((e) => !ours.includes(e)).sort();
}
