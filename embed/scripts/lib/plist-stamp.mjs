// @ts-check
// K3: the build stamps PulseKit.framework's Info.plist carries. PulseKitInfo.swift reads them for
// `info()`: PulseKitVersion, PulseKitBuild and PulseKitGitSha as strings, PulseKitContractMinor,
// PulseKitFormatVersion and PulseKitDbSchema as integers.

import fs from 'node:fs';
import path from 'node:path';

import { buildPlist, parsePlist, rootDict } from './plist.mjs';

/**
 * @typedef {object} Stamps
 * @property {string} version      PulseKit's version: the Pulse app version it was built from
 *   (root package.json; PulseKit, the app and the pulse-embed package share one version, AD18).
 * @property {string} build        Build number.
 * @property {string} gitSha       The commit the build came from.
 * @property {number} contractMinor The contract minor the facade answers (CONTRACT.minor).
 * @property {number} formatVersion The .pulse project format (PROJECT_VERSION).
 * @property {number} dbSchema      The newest schema migration (APP_SCHEMA_VERSION).
 */

/** Info.plist key → stamp field, in the order they're written. */
export const STAMP_KEYS = /** @type {const} */ ([
  ['PulseKitVersion', 'version'],
  ['PulseKitBuild', 'build'],
  ['PulseKitGitSha', 'gitSha'],
  ['PulseKitContractMinor', 'contractMinor'],
  ['PulseKitFormatVersion', 'formatVersion'],
  ['PulseKitDbSchema', 'dbSchema'],
]);

/**
 * Checks the stamps' shapes, so a bad value fails the packaging run instead of shipping.
 * @param {Stamps} stamps
 */
export function validateStamps(stamps) {
  /** @type {string[]} */
  const problems = [];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(stamps.version ?? '')) {
    problems.push(`version "${stamps.version}" is not semver`);
  }
  if (!/^\d+$/.test(stamps.build ?? '')) problems.push(`build "${stamps.build}" is not a number`);
  if (!/^[0-9a-f]{7,40}$/.test(stamps.gitSha ?? '')) {
    problems.push(`gitSha "${stamps.gitSha}" is not a hex commit id`);
  }
  for (const field of /** @type {const} */ (['contractMinor', 'formatVersion', 'dbSchema'])) {
    const n = stamps[field];
    if (!Number.isSafeInteger(n) || n < 0) problems.push(`${field} ${n} is not a whole number`);
  }
  if (problems.length > 0) throw new Error(`Bad PulseKit stamps: ${problems.join('; ')}`);
  return stamps;
}

/**
 * Sets the stamp keys in an XML Info.plist and returns the new XML. Other keys keep their values
 * and order; stamp keys that were already there are replaced in place.
 * @param {string} xml
 * @param {Stamps} stamps
 */
export function stampPlist(xml, stamps) {
  validateStamps(stamps);
  const dict = rootDict(parsePlist(xml));
  for (const [key, field] of STAMP_KEYS) dict.set(key, stamps[field]);
  return buildPlist(dict);
}

/**
 * Reads the numbers the stamps take from the source tree, so they can't drift from the code:
 * CONTRACT.minor (embed/packages/pulse-embed/src/index.ts), PROJECT_VERSION (src/db/project.ts)
 * and APP_SCHEMA_VERSION (the last `when` in drizzle/meta/_journal.json), plus the app version
 * (root package.json) and @mieweb/pulse-embed's version, which AD18 says must match it.
 * @param {string} repoRoot
 * @returns {{ version: string, embedPackageVersion: string, contractMinor: number,
 *   formatVersion: number, dbSchema: number }}
 */
export function readSourceStamps(repoRoot) {
  const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

  const contract =
    /CONTRACT\b[^=]*=\s*Object\.freeze\(\{\s*major:\s*\d+,\s*minor:\s*(\d+)\s*\}\)/.exec(
      read('embed/packages/pulse-embed/src/index.ts'),
    );
  if (!contract)
    throw new Error('CONTRACT.minor not found in embed/packages/pulse-embed/src/index.ts');

  const project = /export const PROJECT_VERSION\s*=\s*(\d+)\s*;/.exec(read('src/db/project.ts'));
  if (!project) throw new Error('PROJECT_VERSION not found in src/db/project.ts');

  /** @type {{ entries: { when: number }[] }} */
  const journal = JSON.parse(read('drizzle/meta/_journal.json'));
  const last = journal.entries.at(-1);
  if (!last) throw new Error('drizzle/meta/_journal.json has no migrations');

  /** @type {{ version: string }} */
  const app = JSON.parse(read('package.json'));
  /** @type {{ version: string }} */
  const embedPkg = JSON.parse(read('embed/packages/pulse-embed/package.json'));

  return {
    version: app.version,
    embedPackageVersion: embedPkg.version,
    contractMinor: Number(contract[1]),
    formatVersion: Number(project[1]),
    dbSchema: last.when,
  };
}
