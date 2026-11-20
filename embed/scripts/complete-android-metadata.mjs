#!/usr/bin/env node
// Completes the metadata of the PulseKit publication that `expo-brownfield build:android
// --release --fused` wrote into its local Maven repository, before package-android.mjs checks
// and zips it (S1-b):
//   - the POM and the Gradle .module get the runtime dependencies the fused template leaves out
//     (Guava, kotlinx coroutines android/guava, atomicfu, kotlinx-serialization-core;
//     lib/android-metadata.mjs says why), at the versions the build resolved (--resolved);
//   - the POM gets the project fields Maven Central requires (name, description, url, license,
//     developers, scm; lib/maven-central.mjs), so the GitHub Release zip and a Central deployment
//     carry the same POM;
//   - the checksum files next to every rewritten file are written again.
// Running it twice changes nothing the second time. `--check` changes nothing and exits 1 when
// something is missing.

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { findPublications } from './lib/android-aar.mjs';
import {
  addModuleDependencies,
  addPomDependencies,
  BASELINE_RUNTIME_DEPENDENCIES,
  moduleFileOf,
  parseDependencyReport,
  RESOLVED_CONFIGURATION,
  resolveBaseline,
} from './lib/android-metadata.mjs';
import { addCentralPomInfo, CHECKSUM_ALGORITHMS, checksumsOf } from './lib/maven-central.mjs';

const HELP = `Usage: node embed/scripts/complete-android-metadata.mjs [options]

Adds the runtime dependencies expo-brownfield's fused publication leaves out to its POM and
.module (${BASELINE_RUNTIME_DEPENDENCIES.map((d) => d.artifact).join(', ')}),
adds the POM fields Maven Central requires, and rewrites the checksums of every file it changes.
Run it after \`npm run build:android\` and before package-android.mjs.

Options:
  --maven <dir>      The localDirectory repository expo-brownfield published to
                     (default: embed/artifacts/android-maven).
  --resolved <file>  The build's \`gradle :pulsekit:dependencies --configuration
                     ${RESOLVED_CONFIGURATION}\` output: the versions come from it, and a
                     module it doesn't resolve is an error. Without it, the versions are
                     spike S1's (${BASELINE_RUNTIME_DEPENDENCIES.map((d) => `${d.artifact} ${d.version}`).join(', ')}).
  --check            Change nothing; exit 1 if a POM or .module lacks anything.
  -h, --help         Show this help.
`;

/** @param {string} dir */
function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

/**
 * Writes a file and every checksum file Gradle wrote next to it.
 * @param {string} file @param {string} text
 */
function writeWithChecksums(file, text) {
  const data = Buffer.from(text, 'utf8');
  fs.writeFileSync(file, data);
  const sums = checksumsOf(data);
  for (const a of CHECKSUM_ALGORITHMS) {
    if (fs.existsSync(`${file}.${a}`)) fs.writeFileSync(`${file}.${a}`, sums[a]);
  }
  if (fs.existsSync(`${file}.asc`)) {
    throw new Error(`${file}.asc would no longer match; remove the signature and sign again`);
  }
}

function main() {
  const { values } = parseArgs({
    options: {
      maven: { type: 'string', default: 'embed/artifacts/android-maven' },
      resolved: { type: 'string' },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const maven = path.resolve(values.maven);
  if (!fs.existsSync(maven) || !fs.statSync(maven).isDirectory()) {
    throw new Error(`--maven ${maven} is not a folder (run \`npm run build:android\` in embed/)`);
  }
  const report = values.resolved ? fs.readFileSync(path.resolve(values.resolved), 'utf8') : null;
  const { dependencies, changed } = resolveBaseline(
    report === null ? null : parseDependencyReport(report),
  );
  console.log(
    `# versions ${report === null ? "(spike S1's defaults)" : `(from ${values.resolved})`}: ` +
      dependencies.map((d) => `${d.group}:${d.artifact}:${d.version}`).join(', '),
  );
  for (const line of changed) console.log(`# note: the build resolves ${line}`);

  const files = listFiles(maven);
  const pubs = findPublications(files);
  if (pubs.length === 0) throw new Error(`${maven} holds no publication (no .pom)`);
  /** @type {string[]} */
  const pending = [];
  for (const pub of pubs) {
    const label = `${pub.group}:${pub.artifact}:${pub.version}`;
    const pomPath = path.join(maven, pub.pom);
    const modulePath = path.join(maven, moduleFileOf(pub));
    if (!fs.existsSync(modulePath)) {
      throw new Error(
        `${label} has no ${path.basename(modulePath)}; Gradle consumers read it before the POM`,
      );
    }

    const pomIn = fs.readFileSync(pomPath, 'utf8');
    const deps = addPomDependencies(pomIn, dependencies);
    const info = addCentralPomInfo(deps.xml);
    const moduleIn = fs.readFileSync(modulePath, 'utf8');
    const mod = addModuleDependencies(moduleIn, dependencies);

    console.log(`\n# ${label}`);
    console.log(`#   POM dependencies added: ${deps.added.join(', ') || 'none'}`);
    console.log(`#   POM fields added: ${info.added.join(', ') || 'none'}`);
    console.log(`#   .module dependencies added: ${mod.added.join(', ') || 'none'}`);
    if (info.xml !== pomIn) pending.push(pub.pom);
    if (mod.text !== moduleIn) pending.push(moduleFileOf(pub));
    if (values.check) continue;
    if (info.xml !== pomIn) writeWithChecksums(pomPath, info.xml);
    if (mod.text !== moduleIn) writeWithChecksums(modulePath, mod.text);
  }

  if (values.check) {
    if (pending.length > 0) {
      throw new Error(
        `incomplete metadata in ${pending.join(', ')}; run complete-android-metadata.mjs ` +
          'without --check',
      );
    }
    console.log('\nThe metadata is complete.');
    return;
  }
  console.log(`\n${pending.length > 0 ? `Rewrote ${pending.join(', ')}` : 'Nothing to change.'}`);
}

try {
  main();
} catch (err) {
  console.error(`complete-android-metadata: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
