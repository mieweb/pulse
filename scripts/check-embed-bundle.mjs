#!/usr/bin/env node
// `npm run check:embed`: proves what ships in PulseKit (the embed plan's B5, §4.2 rules 5–7).
//
//   1. Classification: every native dependency of the root package.json is in embed/deps.json as
//      included or excluded, and that agrees with embed/package.json (what PulseKit links).
//   2. The facade and plugin sources (embed/native, embed/packages, embed/plugins) never use
//      sqlite3_open or SQLiteDatabase: only Pulse JS opens pulse.db.
//   3. The facade still declares the Objective-C names hosts call by selector (PulseKit, shared,
//      handleEventsForBackgroundURLSession:completionHandler:).
//   4. The embed's release JS bundle, for iOS and Android (`expo export:embed`, JS only, no native
//      build), has no module from an excluded package or a standalone-only path; its source map
//      lists every module it holds.
//
// The checks themselves are pure functions in embed/scripts/bundle-check/lib.mjs (with tests).
// Options: --platform ios|android (default: both), --source-map <file> to scan a map you already
// have instead of bundling (then --platform names the map's platform, for the output only).
// Exits 1 on any problem. CI runs it on every PR (.github/workflows/ci.yml, job embed-check).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  bundleProblems,
  classificationProblems,
  facadeProblems,
  forbiddenPackages,
  isNativePackage,
  nativeSymbolProblems,
  parseDeps,
} from '../embed/scripts/bundle-check/lib.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_DIR = 'embed';
const PLATFORMS = ['ios', 'android'];
/** Folders the facade and plugin scan skips: installed or generated, never our source. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.build', '.gradle', 'Pods']);

const { values } = parseArgs({
  options: {
    platform: { type: 'string' },
    'source-map': { type: 'string' },
  },
});
const platforms = values.platform ? [values.platform] : PLATFORMS;
for (const p of platforms) {
  if (!PLATFORMS.includes(p)) throw new Error(`--platform must be ios or android, not "${p}"`);
}
if (values['source-map'] && platforms.length !== 1) {
  throw new Error('--source-map scans one map: name its platform with --platform');
}

const readJson = (/** @type {string} */ rel) =>
  JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8'));

/** @param {string} rel @returns {{ path: string, text: string }[]} */
function sourceFiles(rel) {
  const abs = path.join(repo, rel);
  if (!fs.existsSync(abs)) return [];
  /** @type {{ path: string, text: string }[]} */
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(child));
    } else if (entry.isFile()) {
      const buf = fs.readFileSync(path.join(repo, child));
      if (!buf.includes(0)) out.push({ path: child, text: buf.toString('utf8') });
    }
  }
  return out;
}

/** @param {string} name */
function isNative(name) {
  const dir = path.join(repo, 'node_modules', name);
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`${name} isn't installed in node_modules: run \`npm ci\` first`);
  }
  return isNativePackage(fs.readdirSync(dir));
}

/** @param {string} platform @param {string} out */
function exportBundle(platform, out) {
  const bundle = path.join(out, `${platform}.js`);
  const map = `${bundle}.map`;
  // prettier-ignore
  const args = [
    'expo', 'export:embed',
    '--entry-file', 'index.ts',
    '--platform', platform,
    '--dev', 'false',
    '--minify', 'false',
    '--bundle-output', bundle,
    '--sourcemap-output', map,
    '--assets-dest', path.join(out, `${platform}-assets`),
  ];
  execFileSync('npx', args, {
    cwd: path.join(repo, PROJECT_DIR),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, EXPO_NO_TELEMETRY: '1' },
  });
  return map;
}

/** @type {{ name: string, problems: string[], note?: string }[]} */
const results = [];
const started = Date.now();

const { deps, problems: depsProblems } = parseDeps(readJson('embed/deps.json'));
results.push({
  name: 'Native dependencies classified (embed/deps.json)',
  problems: deps
    ? classificationProblems({
        rootPackage: readJson('package.json'),
        embedPackage: readJson(`${PROJECT_DIR}/package.json`),
        deps,
        isNative,
      })
    : depsProblems,
  note: deps
    ? `${Object.keys(deps.included).length} included, ${Object.keys(deps.excluded).length} excluded`
    : undefined,
});

const nativeSources = ['embed/native', 'embed/packages', 'embed/plugins'].flatMap(sourceFiles);
results.push({
  name: 'No sqlite3_open / SQLiteDatabase in the facade and plugins',
  problems: nativeSymbolProblems(nativeSources),
  note: `${nativeSources.length} files`,
});

const facade = sourceFiles('embed/native/ios').filter((f) => f.path.endsWith('.swift'));
results.push({
  name: 'Facade declares the selectors hosts call',
  problems: facadeProblems(facade),
});

if (deps) {
  const packages = forbiddenPackages(deps);
  const tmp = values['source-map'] ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'embed-check-'));
  try {
    for (const platform of platforms) {
      const t0 = Date.now();
      const map = values['source-map'] ?? exportBundle(platform, /** @type {string} */ (tmp));
      const sourceMap = JSON.parse(fs.readFileSync(map, 'utf8'));
      const count = Array.isArray(sourceMap.sources) ? sourceMap.sources.length : 0;
      results.push({
        name: `${platform} bundle contains nothing from the must-not-contain list`,
        problems: bundleProblems(sourceMap, { projectDir: PROJECT_DIR, packages }),
        note: `${count} sources, ${((Date.now() - t0) / 1000).toFixed(1)} s`,
      });
    }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('\nEmbed check');
let failed = 0;
for (const { name, problems, note } of results) {
  console.log(`${problems.length ? '✗' : '✓'} ${name}${note ? ` (${note})` : ''}`);
  for (const p of problems) console.log(`    ${p}`);
  failed += problems.length;
}
const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (failed) {
  console.log(`\n${failed} problem${failed === 1 ? '' : 's'} (${seconds} s)`);
  process.exitCode = 1;
} else {
  console.log(`\nAll embed checks pass (${seconds} s)`);
}
