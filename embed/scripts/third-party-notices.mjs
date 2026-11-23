#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES for a PulseKit release: the licenses of the npm packages the embed
// app is built from, the CocoaPods with a license file, and the prebuilt native frameworks (see
// lib/release-notices.mjs). Run it after `npm ci` and, for the pods, after the embed's pod install.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { collectNpmPackages, collectPods, formatNotices } from './lib/release-notices.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const HELP = `Usage: node embed/scripts/third-party-notices.mjs --out <file> [options]

Options:
  --out <file>       Where to write the notices (Markdown).
  --pods <dir>       The embed's CocoaPods folder (default: embed/ios/Pods; skipped if absent).
  --version <v>      The PulseKit version, for the title (default: the root package.json's).
  --strict           Fail when a required npm dependency doesn't resolve.
  -h, --help         Show this help.
`;

function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      pods: { type: 'string' },
      version: { type: 'string' },
      strict: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!values.out) throw new Error('--out is required');

  const embedDir = path.join(repoRoot, 'embed');
  const embedPkg = JSON.parse(fs.readFileSync(path.join(embedDir, 'package.json'), 'utf8'));
  /** @type {string[]} */
  const roots = [embedDir];
  const modulesRel = embedPkg.expo?.autolinking?.nativeModulesDir;
  if (typeof modulesRel === 'string') {
    const modulesDir = path.resolve(embedDir, modulesRel);
    if (fs.existsSync(modulesDir)) {
      for (const name of fs.readdirSync(modulesDir).sort()) {
        if (fs.existsSync(path.join(modulesDir, name, 'package.json'))) {
          roots.push(path.join(modulesDir, name));
        }
      }
    }
  }

  const { packages, missing } = collectNpmPackages(roots, repoRoot);
  if (missing.length > 0) {
    const message = `unresolved npm dependencies:\n  ${missing.join('\n  ')}`;
    if (values.strict) throw new Error(message);
    console.warn(`third-party-notices: warning: ${message}`);
  }
  const podsDir = path.resolve(values.pods ?? path.join(embedDir, 'ios', 'Pods'));
  const pods = collectPods(podsDir);
  const version =
    values.version ??
    JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

  const text = formatNotices({ title: `PulseKit ${version}: third-party notices`, packages, pods });
  fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  fs.writeFileSync(values.out, text);
  console.log(
    `wrote ${values.out}: ${packages.length} npm packages, ${pods.length} pods` +
      `${fs.existsSync(podsDir) ? '' : ` (no ${podsDir})`}`,
  );
}

try {
  main();
} catch (err) {
  console.error(`third-party-notices: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
