#!/usr/bin/env node
// Checks the PulseKit Android publication that `expo-brownfield build:android --release --fused`
// wrote into a local Maven repository, then zips that repository as one release asset (G2, G5).
// It refuses a build that would hurt a host:
//   1. ABIs: exactly the expected set, each with the same libraries (a partly filled ABI loads
//      nothing on that ABI) but for per-ABI variants such as whisper.rn's CPU-tuned builds.
//   2. 16 KB pages: every 64-bit .so has PT_LOAD p_align >= 16384 (Google Play, Android 15+
//      targets); PT_GNU_RELRO's end alignment is reported.
//   3. minSdk: the AAR's manifest asks for no more than the floor.
//   4. Permissions: the merged manifest asks only for the allowlist, and for none of the
//      permissions PulseKit removes.
//   5. Dependencies: every POM and .module dependency resolves (a version, no system scope, no dev
//      tooling, no artifact of ours the repository lacks), and both declare the runtime baseline
//      the fused template leaves out (S1-b; complete-android-metadata.mjs adds it); the POM's
//      list is written out as the dependency matrix.
//   6. R8: the AAR carries consumer rules that keep the facade.
//   7. Facade: classes.jar has PulseKit, PulseActivity and PulseUploadService.
// The pure rules live in lib/android-aar.mjs and lib/android-elf.mjs; this file reads the AAR
// through `unzip` (lib/runner.mjs) and writes the outputs. The checks run in a dry run too; only
// the writes are skipped.

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  ABIS_64,
  abiProblems,
  AAR_CONSUMER_RULES,
  ALLOWED_PERMISSIONS,
  androidBuildSettings,
  CHECKS,
  dependencyProblem,
  findPublications,
  formatDependencies,
  MIN_SDK_FLOOR,
  missingFacadeClasses,
  mavenZipEntries,
  nativeLibraries,
  parseManifest,
  parsePom,
  permissionCheck,
  r8Problems,
  RELEASE_ABIS,
  repositoryProblems,
  sortDependencies,
  zipFiles,
} from './lib/android-aar.mjs';
import { pageCheck, parseElf } from './lib/android-elf.mjs';
import { missingBaseline, moduleDependencies, moduleFileOf } from './lib/android-metadata.mjs';
import { formatSha256Sums } from './lib/checksums.mjs';
import { assertSafeOut } from './lib/out-dir.mjs';
import { ANDROID_MAVEN_ZIP } from './lib/release-assets.mjs';
import { createRunner } from './lib/runner.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** What a run writes into --out; `--clean` deletes only a folder holding just these. */
const OUT_ENTRIES = [
  'release',
  'android-dependencies.json',
  'android-dependencies.md',
  'android-report.json',
  '.DS_Store',
];

/** The ELF machine each ABI's libraries must be built for. */
const ABI_MACHINE = /** @type {Record<string, string>} */ ({
  'arm64-v8a': 'aarch64',
  'armeabi-v7a': 'arm',
  x86_64: 'x86_64',
  x86: 'x86',
});

const appJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'embed/app.json'), 'utf8'));
const settings = androidBuildSettings(appJson);
const DEFAULT_ABIS = settings.abis ?? [...RELEASE_ABIS];
const DEFAULT_MIN_SDK = settings.minSdk ?? MIN_SDK_FLOOR;

const HELP = `Usage: node embed/scripts/package-android.mjs [options]

Checks the PulseKit AAR(s) in expo-brownfield's local Maven repository, then zips the repository
as ${ANDROID_MAVEN_ZIP} and prints its SHA-256 line.

Relative paths are relative to the current folder.

Options:
  --maven <dir>       The localDirectory repository expo-brownfield published to
                      (default: embed/artifacts/android-maven). It must hold one version of
                      each artifact and no debug build.
  --out <dir>         Where to write (default: embed/artifacts/pulsekit-android). It must be empty
                      or absent, unless --clean is given, and may not be, contain or sit inside
                      --maven.
  --clean             Delete --out first. Only an earlier run's output is deleted.
  --abis <list>       The ABIs the publication must carry, comma-separated (default:
                      ${DEFAULT_ABIS.join(',')}, from embed/app.json's buildArchs). A debug build
                      (\`npm run build:android:debug\`) adds x86_64.
  --min-sdk <n>       The highest minSdkVersion an AAR may declare (default: ${DEFAULT_MIN_SDK}, from
                      embed/app.json's minSdkVersion).
  --allow-permission <name>
                      Accept one more permission in the merged manifest; repeatable.
  --allow-failing <check>
                      Report a check's failures as warnings instead of stopping; repeatable.
                      Checks: ${CHECKS.join(', ')}.
  --dry-run           Run every check and print the plan; write nothing (the AARs are still
                      unpacked into a temporary folder to read their libraries).
  -h, --help          Show this help.

Writes:
  <out>/release/${ANDROID_MAVEN_ZIP}  the whole repository, entries sorted, fixed timestamps
  <out>/release/SHA256SUMS            its SHA-256 (shasum's text format)
  <out>/android-dependencies.json     the dependency matrix from the POM(s)
  <out>/android-dependencies.md       the same, as a Markdown table
  <out>/android-report.json           every check's findings
`;

/** Every file under `dir`, relative and `/`-separated, sorted. @param {string} dir */
function listFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .sort();
}

/** `unzip` output is bytes (a .so, or UTF-8 text); latin1 carries them through the runner intact. */
const reader = createRunner({
  dryRun: false,
  exec: (cmd, args) =>
    execFileSync(cmd, args, {
      encoding: 'latin1',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 1 << 30,
    }),
});
/** @param {string} cmd @param {string[]} args */
const readText = (cmd, args) =>
  Buffer.from(reader.inspect(cmd, args) ?? '', 'latin1').toString('utf8');

function main() {
  const { values } = parseArgs({
    options: {
      maven: { type: 'string', default: 'embed/artifacts/android-maven' },
      out: { type: 'string', default: 'embed/artifacts/pulsekit-android' },
      clean: { type: 'boolean', default: false },
      abis: { type: 'string' },
      'min-sdk': { type: 'string' },
      'allow-permission': { type: 'string', multiple: true },
      'allow-failing': { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const dryRun = values['dry-run'];
  const maven = path.resolve(values.maven);
  const out = path.resolve(values.out);
  const abis = values.abis
    ? values.abis
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
    : DEFAULT_ABIS;
  const minSdk = values['min-sdk'] === undefined ? DEFAULT_MIN_SDK : Number(values['min-sdk']);
  if (!Number.isInteger(minSdk)) throw new Error(`--min-sdk ${values['min-sdk']} is not a number`);
  const allowFailing = new Set(values['allow-failing'] ?? []);
  for (const check of allowFailing) {
    if (!(/** @type {readonly string[]} */ (CHECKS).includes(check))) {
      throw new Error(`--allow-failing ${check}: no such check (${CHECKS.join(', ')})`);
    }
  }
  const allowed = [
    ...ALLOWED_PERMISSIONS,
    ...(values['allow-permission'] ?? []).map((name) => ({ name })),
  ];

  // --- Inputs and --out ----------------------------------------------------------------------
  if (!fs.existsSync(maven) || !fs.statSync(maven).isDirectory()) {
    throw new Error(`--maven ${maven} is not a folder (run \`npm run build:android\` in embed/)`);
  }
  assertSafeOut(out, [
    { path: maven, label: '--maven' },
    { path: repoRoot, label: 'the repo', allowInside: true },
    { path: path.join(repoRoot, '.git'), label: "the repo's .git" },
  ]);
  if (fs.existsSync(out) && !fs.statSync(out).isDirectory())
    throw new Error(`--out ${out} is a file`);
  const outEntries = fs.existsSync(out) ? fs.readdirSync(out) : [];
  if (outEntries.length > 0) {
    if (!values.clean) throw new Error(`--out ${out} is not empty (pass --clean to replace it)`);
    const foreign = outEntries.filter((e) => !OUT_ENTRIES.includes(e)).sort();
    if (foreign.length > 0) {
      throw new Error(
        `--clean deletes only an earlier run's output, and ${out} also holds: ${foreign.join(', ')}`,
      );
    }
  }

  const files = listFiles(maven);
  const pubs = findPublications(files);
  const repoProblems = repositoryProblems(pubs);
  if (repoProblems.length > 0) {
    throw new Error(`Can't package ${maven}:\n  ${repoProblems.join('\n  ')}`);
  }

  reader.step(`PulseKit Android packaging${dryRun ? ' (dry run: nothing is written)' : ''}`);
  console.log(`# maven:  ${maven}\n# out:    ${out}`);
  console.log(`# expect: ABIs ${abis.join(', ')}; minSdk <= ${minSdk}`);
  console.log(`# found:  ${pubs.map((p) => `${p.group}:${p.artifact}:${p.version}`).join(', ')}`);

  /** @type {Map<string, string[]>} */
  const problems = new Map(CHECKS.map((c) => [c, []]));
  const fail = (/** @type {string} */ check, /** @type {string} */ message) =>
    problems.get(check)?.push(message);

  // --- Read every publication ----------------------------------------------------------------
  const shipped = new Set(pubs.map((p) => `${p.group}:${p.artifact}`));
  /** @type {(import('./lib/android-aar.mjs').PomDependency & { from: string })[]} */
  const depRows = [];
  /** @type {import('./lib/android-aar.mjs').PomDependency[]} */
  const moduleDeps = [];
  /** @type {Map<string, string[]>} */
  const libsByAbi = new Map();
  /** @type {import('./lib/android-aar.mjs').ManifestPermission[]} */
  const permissions = [];
  /** @type {{ aar: string, minSdk: number | null }[]} */
  const minSdks = [];
  /** @type {string[]} */
  const rules = [];
  /** @type {string[]} */
  const classEntries = [];
  /** @type {{ library: string, machine: string, minAlign: number | null, aligned: boolean,
   *   relroEndAligned: boolean | null }[]} */
  const pages = [];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsekit-aar-'));
  try {
    for (const pub of pubs) {
      const label = `${pub.group}:${pub.artifact}:${pub.version}`;
      reader.step(label);
      const pom = parsePom(fs.readFileSync(path.join(maven, pub.pom), 'utf8'));
      if (pom.group !== pub.group || pom.artifact !== pub.artifact || pom.version !== pub.version) {
        throw new Error(
          `${pub.pom} names ${pom.group}:${pom.artifact}:${pom.version}, not its own path (${label})`,
        );
      }
      for (const dep of pom.dependencies) {
        depRows.push({ ...dep, from: `${pub.artifact}:${pub.version}` });
        const problem = dependencyProblem(dep, { ownGroup: pub.group, shipped });
        if (problem) fail('dependencies', `${pub.artifact}: ${problem}`);
      }
      // Gradle consumers read the .module before the POM, so it gets the same checks.
      const moduleFile = path.join(maven, moduleFileOf(pub));
      if (fs.existsSync(moduleFile)) {
        for (const dep of moduleDependencies(fs.readFileSync(moduleFile, 'utf8'))) {
          moduleDeps.push(dep);
          const problem = dependencyProblem(dep, { ownGroup: pub.group, shipped });
          if (problem) fail('dependencies', `${pub.artifact} (.module): ${problem}`);
        }
      } else {
        fail('dependencies', `${pub.artifact}: no ${path.basename(moduleFile)} next to the POM`);
      }
      if (pub.aar === null) continue;

      const aar = path.join(maven, pub.aar);
      const entries = (reader.inspect('unzip', ['-Z1', aar]) ?? '').split('\n').filter(Boolean);
      const libs = nativeLibraries(entries);
      for (const [abi, names] of libs) {
        libsByAbi.set(abi, [...new Set([...(libsByAbi.get(abi) ?? []), ...names])].sort());
      }

      if (entries.includes('AndroidManifest.xml')) {
        const manifest = parseManifest(readText('unzip', ['-p', aar, 'AndroidManifest.xml']));
        minSdks.push({ aar: pub.aar, minSdk: manifest.minSdk });
        permissions.push(...manifest.permissions);
      } else {
        fail('minsdk', `${pub.artifact}: the AAR has no AndroidManifest.xml`);
      }
      if (entries.includes(AAR_CONSUMER_RULES)) {
        rules.push(readText('unzip', ['-p', aar, AAR_CONSUMER_RULES]));
      }

      // classes.jar and the 64-bit libraries go to a temporary folder, read from there.
      const wanted = [
        ...(entries.includes('classes.jar') ? ['classes.jar'] : []),
        ...entries.filter((e) =>
          ABIS_64.some((abi) => e.startsWith(`jni/${abi}/`) && e.endsWith('.so')),
        ),
      ];
      const dir = path.join(tmp, pub.artifact);
      if (wanted.length > 0) reader.run('unzip', ['-q', '-o', aar, ...wanted, '-d', dir]);
      if (wanted.includes('classes.jar')) {
        const listing = reader.inspect('unzip', ['-Z1', path.join(dir, 'classes.jar')]) ?? '';
        classEntries.push(...listing.split('\n').filter(Boolean));
      }
      for (const entry of wanted.filter((e) => e.endsWith('.so'))) {
        const abi = entry.split('/')[1];
        const elf = parseElf(fs.readFileSync(path.join(dir, entry)), entry);
        const check = pageCheck(elf);
        pages.push({ library: entry, machine: elf.machineName, ...check });
        if (elf.elfClass !== 64 || elf.machineName !== ABI_MACHINE[abi]) {
          fail(
            'abis',
            `${entry} is ELF${elf.elfClass} ${elf.machineName}, not ${ABI_MACHINE[abi]}`,
          );
        }
        if (!check.aligned) {
          fail(
            'pages',
            `${entry}: a LOAD segment is aligned to ${check.minAlign} bytes, not 16 KB`,
          );
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // --- Checks over everything read -------------------------------------------------------------
  const runtimeBaseline = [
    { where: 'POM', missing: missingBaseline(depRows.filter((d) => d.scope !== 'test')) },
    { where: '.module', missing: missingBaseline(moduleDeps.filter((d) => d.scope === 'runtime')) },
  ];
  for (const { where, missing } of runtimeBaseline) {
    if (missing.length > 0) {
      fail(
        'dependencies',
        `the ${where} doesn't declare ${missing.join(', ')}; a host crashes without them ` +
          '(run embed/scripts/complete-android-metadata.mjs after the build)',
      );
    }
  }
  for (const p of abiProblems(libsByAbi, abis)) fail('abis', p);
  for (const { aar, minSdk: declared } of minSdks) {
    if (declared === null) fail('minsdk', `${aar}: the manifest has no minSdkVersion`);
    else if (declared > minSdk) fail('minsdk', `${aar}: minSdkVersion ${declared} > ${minSdk}`);
  }
  const perms = permissionCheck(permissions, { allowed });
  for (const p of perms.problems) fail('permissions', p);
  for (const p of r8Problems(rules.length > 0 ? rules.join('\n') : null)) fail('r8', p);
  for (const c of missingFacadeClasses(classEntries)) {
    fail('facade', `classes.jar has no ${c} (were embed/native/android's sources compiled in?)`);
  }

  reader.step('Report');
  for (const [abi, names] of libsByAbi) console.log(`# ${abi}: ${names.length} libraries`);
  for (const p of pages) {
    const relro =
      p.relroEndAligned === null
        ? 'no RELRO'
        : `RELRO end ${p.relroEndAligned ? '' : 'not '}16 KB aligned`;
    console.log(`# ${p.aligned ? 'ok  ' : 'FAIL'} ${p.library}: p_align ${p.minAlign}; ${relro}`);
  }
  console.log(`# minSdk: ${minSdks.map((m) => `${m.minSdk}`).join(', ')}`);
  console.log(
    `# permissions: ${perms.requested.map((p) => p.name.replace('android.permission.', '')).join(', ')}`,
  );
  console.log(`# removal markers: ${perms.markers.length} (${perms.markers.join(', ') || 'none'})`);
  console.log(`# dependencies: ${depRows.length}`);
  /** @type {string[]} */
  const fatal = [];
  for (const [check, list] of problems) {
    for (const p of list) {
      const allowedToFail = allowFailing.has(check);
      console.log(`# ${allowedToFail ? 'warning' : 'error'} [${check}] ${p}`);
      if (!allowedToFail) fatal.push(`[${check}] ${p}`);
    }
  }
  if (fatal.length > 0) {
    throw new Error(
      `the publication fails ${fatal.length} check(s):\n  ${fatal.join('\n  ')}\n` +
        'Pass --allow-failing <check> to report a check without stopping.',
    );
  }

  // --- Write ---------------------------------------------------------------------------------
  const writer = createRunner({ dryRun });
  writer.step('Zip, checksum and reports');
  if (outEntries.length > 0) writer.remove(out); // checked above: only an earlier run's output
  const releaseDir = path.join(out, 'release');
  writer.mkdir(releaseDir);

  const zipEntries = mavenZipEntries(files);
  const zip = zipFiles(
    zipEntries.map((name) => ({ name, data: fs.readFileSync(path.join(maven, name)) })),
  );
  const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
  writer.writeFile(
    path.join(releaseDir, ANDROID_MAVEN_ZIP),
    /** @type {string} */ (/** @type {unknown} */ (zip)),
    `${zipEntries.length} files, ${zip.length} bytes`,
  );
  const sums = formatSha256Sums([{ name: ANDROID_MAVEN_ZIP, sha256 }]);
  writer.writeFile(path.join(releaseDir, 'SHA256SUMS'), sums, `SHA-256 of ${ANDROID_MAVEN_ZIP}`);

  const rows = sortDependencies(depRows);
  const title = `PulseKit Android dependencies (${pubs.map((p) => `${p.artifact} ${p.version}`).join(', ')})`;
  writer.writeFile(
    path.join(out, 'android-dependencies.json'),
    `${JSON.stringify({ publications: pubs.map((p) => `${p.group}:${p.artifact}:${p.version}`), dependencies: rows }, null, 2)}\n`,
    `${rows.length} dependencies`,
  );
  writer.writeFile(
    path.join(out, 'android-dependencies.md'),
    formatDependencies({ title, rows }),
    'the dependency matrix as a Markdown table',
  );
  writer.writeFile(
    path.join(out, 'android-report.json'),
    `${JSON.stringify(
      {
        publications: pubs.map((p) => `${p.group}:${p.artifact}:${p.version}`),
        expected: { abis, minSdk },
        abis: Object.fromEntries(libsByAbi),
        pages,
        minSdk: minSdks,
        permissions: { requested: perms.requested, removalMarkers: perms.markers },
        warnings: Object.fromEntries([...problems].filter(([, list]) => list.length > 0)),
        zip: { name: ANDROID_MAVEN_ZIP, sha256, bytes: zip.length },
      },
      null,
      2,
    )}\n`,
    'every check and its findings',
  );
  process.stdout.write(`\n${sums}`);
  console.log(`${dryRun ? 'Dry run: nothing written.' : `Done: ${releaseDir}`}`);
}

try {
  main();
} catch (err) {
  console.error(`package-android: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
