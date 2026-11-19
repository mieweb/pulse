#!/usr/bin/env node
// Packages expo-brownfield's iOS output (embed/artifacts) into what a PulseKit release ships:
// one zip per xcframework, an all-in-one zip for CocoaPods, SHA256SUMS, the dSYMs and a size
// report (plan V0.2 = K1, K3), with privacy manifests and, given --sign, signatures (K2).
// It replaces embed-spike's stage.sh. Run it on a Mac (ditto, dsymutil, lipo, strip, otool,
// plutil); `--dry-run` prints every step instead and writes nothing.
//
// Steps, per xcframework:
//   1. Keep the iOS device and Simulator slices only. This also rebuilds hermesvm, whose
//      macOS and Catalyst slices carry absolute symlinks into the producer's Pods folder.
//   2. Stop on any absolute (or escaping) symlink left in what ships.
//   3. Copy the dSYMs out (or make them with dsymutil), then `strip -x` each binary.
//   4. Stamp PulseKit.framework's Info.plist (PulseKitVersion, PulseKitBuild, PulseKitGitSha,
//      PulseKitContractMinor, PulseKitFormatVersion, PulseKitDbSchema).
//   5. Write the privacy manifest into each framework that needs one (lib/release-privacy).
//   6. With --sign, `codesign --timestamp` the xcframework (after everything inside it is final).
// Before anything: refuse an --out that is, contains or sits inside what it reads (see lib/out-dir).
// Then: add the vendored frameworks the brownfield CLI leaves out (whisper.rn's rnwhisper), check
// that every @rpath framework a binary loads ships, zip, copy the --attach files, write SHA256SUMS
// (every asset) and the size report.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { formatSha256Sums, sha256File } from './lib/checksums.mjs';
import { hasDebugMap } from './lib/debug-map.mjs';
import { assertSafeOut, foreignOutEntries, OUT_ENTRIES } from './lib/out-dir.mjs';
import { frameworkName, planSlices, prunedManifest, sharedEntries } from './lib/platforms.mjs';
import { buildPlist, isBinaryPlist, parsePlist } from './lib/plist.mjs';
import { readSourceStamps, stampPlist, STAMP_KEYS, validateStamps } from './lib/plist-stamp.mjs';
import { DSYMS_ZIP, XCFRAMEWORKS_ZIP } from './lib/release-assets.mjs';
import {
  PRIVACY_MANIFESTS,
  privacyDestinations,
  privacyManifestProblems,
} from './lib/release-privacy.mjs';
import { missingRpathDependencies, rpathFrameworks } from './lib/rpath.mjs';
import { createRunner } from './lib/runner.mjs';
import { buildSizeReport, formatSizeReport, treeSize } from './lib/size-report.mjs';
import { describeUnsafeSymlinks, findUnsafeSymlinks } from './lib/symlinks.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Frameworks PulseKit loads that expo-brownfield doesn't put in its output. */
const VENDORED = ['node_modules/whisper.rn/ios/rnwhisper.xcframework'];
const ZIP_FLAGS = ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--noacl', '--keepParent'];

const HELP = `Usage: node embed/scripts/package-ios.mjs [options]

Packages expo-brownfield's iOS xcframeworks into PulseKit release assets.

Relative --input, --out and --vendored paths are relative to the current folder.

Options:
  --input <dir>     expo-brownfield's output folder of *.xcframework (default: embed/artifacts)
  --out <dir>       Where to write (default: embed/artifacts/pulsekit-ios). It must be empty
                    or absent, unless --clean is given. It may not be, contain, or sit inside
                    an xcframework it reads, and may not be or contain --input or the repo.
  --clean           Delete --out first. Only an earlier run's output (${OUT_ENTRIES.join(', ')})
                    is deleted; anything else in --out stops the run.
  --vendored <dir>  An xcframework to ship when --input lacks it; repeatable. Giving it
                    replaces the default list (${VENDORED.join(', ')}, relative to the repo).
  --version <v>     PulseKitVersion (default: the app version in the root package.json, which
                    PulseKit and @mieweb/pulse-embed share, AD18).
  --build <n>       PulseKitBuild (default: $GITHUB_RUN_NUMBER, else the commit count).
  --git-sha <sha>   PulseKitGitSha (default: git rev-parse HEAD).
  --sign <identity> codesign --timestamp each packaged xcframework with this identity (a name or
                    SHA-1, as \`security find-identity\` prints it). Without it nothing is signed.
  --keychain <path> The keychain holding --sign's identity (default: the search list).
  --attach <file>   Copy a file into release/ and list it in SHA256SUMS (the source map, the
                    notices); repeatable.
  --dry-run         Print every step and write nothing.
  -h, --help        Show this help.

Writes:
  <out>/xcframeworks/   the packaged xcframeworks (what a local host links against)
  <out>/dSYMs/          debug symbols, per xcframework and slice
  <out>/release/        <Name>.xcframework.zip per xcframework, ${XCFRAMEWORKS_ZIP} (all of
                        them, for CocoaPods), ${DSYMS_ZIP}, the --attach files, SHA256SUMS,
                        size-report.md, size-report.json
Check a download with: cd <out>/release && shasum -a 256 -c SHA256SUMS
`;

/** @param {string} file */
function readManifest(file) {
  const raw = fs.readFileSync(file);
  // Reading an input plist changes nothing, so it runs in a dry run too.
  const xml = isBinaryPlist(raw)
    ? execFileSync('plutil', ['-convert', 'xml1', '-o', '-', file], { encoding: 'utf8' })
    : raw.toString('utf8');
  return parsePlist(xml);
}

/** @param {readonly string[]} args */
function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

/**
 * Whether dsymutil has a debug map to read in `binary`. A dry run can't look (the staged binary
 * isn't there), so it plans dsymutil; if nm fails, dsymutil runs and reports the problem itself.
 * @param {import('./lib/runner.mjs').Runner} runner
 * @param {string} binary
 */
function debugMapOf(runner, binary) {
  try {
    const listing = runner.inspect('nm', ['-ap', binary]);
    return listing === null || hasDebugMap(listing);
  } catch {
    return true;
  }
}

/** @param {string} file */
const fileSize = (file) => (fs.existsSync(file) ? fs.statSync(file).size : 0);

function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', default: 'embed/artifacts' },
      out: { type: 'string', default: 'embed/artifacts/pulsekit-ios' },
      clean: { type: 'boolean', default: false },
      vendored: { type: 'string', multiple: true },
      version: { type: 'string' },
      build: { type: 'string' },
      'git-sha': { type: 'string' },
      sign: { type: 'string' },
      keychain: { type: 'string' },
      attach: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const dryRun = values['dry-run'];
  const input = path.resolve(values.input);
  const out = path.resolve(values.out);
  const runner = createRunner({ dryRun });

  // --- Inputs ------------------------------------------------------------------------------
  if (!fs.existsSync(input)) throw new Error(`--input ${input} does not exist`);
  const sources = fs
    .readdirSync(input)
    .filter((e) => e.endsWith('.xcframework'))
    .sort()
    .map((name) => ({ name, dir: path.join(input, name), vendored: false }));
  if (sources.length === 0) throw new Error(`no *.xcframework in ${input}`);
  if (!sources.some((s) => s.name === 'PulseKit.xcframework')) {
    throw new Error(`${input} has no PulseKit.xcframework; is it expo-brownfield's iOS output?`);
  }
  // Given paths are relative to the current folder; the default is relative to the repo.
  const vendored = values.vendored
    ? values.vendored.map((p) => path.resolve(p))
    : VENDORED.map((rel) => path.resolve(repoRoot, rel));
  for (const dir of vendored) {
    const name = path.basename(dir);
    if (sources.some((s) => s.name === name)) continue; // the build already has it
    if (!fs.existsSync(path.join(dir, 'Info.plist'))) {
      throw new Error(`vendored ${name} not found at ${dir} (run npm ci?)`);
    }
    sources.push({ name, dir, vendored: true });
  }

  // Nothing has been written yet; refuse an --out that `--clean` or the copies would damage.
  assertSafeOut(out, [
    { path: input, label: '--input', allowInside: true },
    { path: repoRoot, label: 'the repo', allowInside: true },
    { path: path.join(repoRoot, '.git'), label: "the repo's .git" },
    ...sources.map((s) => ({ path: s.dir, label: `the input ${s.name}` })),
  ]);
  if (fs.existsSync(out) && !fs.statSync(out).isDirectory()) {
    throw new Error(`--out ${out} is a file`);
  }
  const outEntries = fs.existsSync(out) ? fs.readdirSync(out) : [];
  if (outEntries.length > 0) {
    if (!values.clean) throw new Error(`--out ${out} is not empty (pass --clean to replace it)`);
    const foreign = foreignOutEntries(outEntries);
    if (foreign.length > 0) {
      throw new Error(
        `--clean deletes only an earlier run's output, and ${out} also holds: ${foreign.join(', ')}`,
      );
    }
  }

  const stamps = (() => {
    const { embedPackageVersion, ...fromSource } = readSourceStamps(repoRoot);
    if (values.version === undefined && embedPackageVersion !== fromSource.version) {
      console.warn(
        `package-ios: warning: @mieweb/pulse-embed is ${embedPackageVersion} but the app is ` +
          `${fromSource.version}; PulseKitVersion uses the app version (AD18: they share one).`,
      );
    }
    return validateStamps({
      ...fromSource,
      version: values.version ?? fromSource.version,
      build: values.build ?? process.env.GITHUB_RUN_NUMBER ?? git(['rev-list', '--count', 'HEAD']),
      gitSha: values['git-sha'] ?? git(['rev-parse', 'HEAD']),
    });
  })();

  runner.step(`PulseKit iOS packaging${dryRun ? ' (dry run: nothing is written)' : ''}`);
  console.log(`# input:  ${input}\n# out:    ${out}`);
  console.log(`# stamps: ${STAMP_KEYS.map(([key, field]) => `${key}=${stamps[field]}`).join(' ')}`);

  // --- Plan and check everything before writing anything --------------------------------------
  /** @type {string[]} */
  const problems = [];
  const jobs = sources.map((src) => {
    const manifest = readManifest(path.join(src.dir, 'Info.plist'));
    const { keep, drop } = planSlices(src.name, manifest);
    const shared = sharedEntries(fs.readdirSync(src.dir), [...keep, ...drop]);
    const shipped = new Set([...keep.map((l) => l.id), ...shared]);
    const unsafe = findUnsafeSymlinks(src.dir).filter((l) =>
      shipped.has(l.path.split(path.sep)[0]),
    );
    problems.push(...describeUnsafeSymlinks(src.name, unsafe));
    for (const lib of keep) {
      if (!fs.existsSync(path.join(src.dir, lib.id, lib.binaryPath))) {
        problems.push(`${src.name}/${lib.id}/${lib.binaryPath}: binary missing`);
      }
    }
    /** @type {string | undefined} */
    const privacySource =
      PRIVACY_MANIFESTS[/** @type {keyof typeof PRIVACY_MANIFESTS} */ (src.name)];
    /** @type {{ xml: string, destinations: string[] } | null} */
    let privacy = null;
    if (privacySource) {
      const xml = fs.readFileSync(path.join(repoRoot, privacySource), 'utf8');
      problems.push(...privacyManifestProblems(xml).map((p) => `${privacySource}: ${p}`));
      privacy = { xml, destinations: privacyDestinations(src.name, keep) };
    }
    return { ...src, manifest, keep, drop, shared, privacy };
  });
  for (const name of Object.keys(PRIVACY_MANIFESTS)) {
    if (!jobs.some((j) => j.name === name)) {
      console.warn(
        `package-ios: warning: ${name} isn't in this build; its privacy manifest is skipped`,
      );
    }
  }
  const attachments = (values.attach ?? []).map((file) => path.resolve(file));
  /** @type {Set<string>} */
  const releaseNames = new Set([
    ...jobs.map((j) => `${j.name}.zip`),
    XCFRAMEWORKS_ZIP,
    DSYMS_ZIP,
    'SHA256SUMS',
    'size-report.md',
    'size-report.json',
  ]);
  for (const file of attachments) {
    const name = path.basename(file);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
      problems.push(`--attach ${file}: no such file`);
    else if (releaseNames.has(name))
      problems.push(`--attach ${file}: release/ already has a ${name}`);
    releaseNames.add(name);
  }
  if (problems.length > 0) {
    throw new Error(`Can't package:\n  ${problems.join('\n  ')}`);
  }

  // Every @rpath framework a binary loads ships. strip doesn't touch load commands, so the input
  // binaries answer this before anything is written.
  runner.step('Check the @rpath closure');
  const shippedFrameworks = jobs
    .flatMap((j) => j.keep.map(frameworkName))
    .filter((n) => n !== null);
  /** @type {Map<string, string[]>} */
  const loads = new Map();
  for (const job of jobs) {
    for (const lib of job.keep) {
      const listing = runner.inspect('otool', ['-L', path.join(job.dir, lib.id, lib.binaryPath)]);
      if (listing !== null)
        loads.set(
          `${job.name}/${lib.id}`,
          rpathFrameworks(listing, frameworkName(lib) ?? undefined),
        );
    }
  }
  const missing = missingRpathDependencies(loads, shippedFrameworks);
  if (missing.length > 0) {
    throw new Error(
      `@rpath frameworks nothing ships:\n  ${missing.map((m) => `${m.binary} loads ${m.framework}`).join('\n  ')}\n` +
        'Add the xcframework to the build output or pass it with --vendored.',
    );
  }

  if (outEntries.length > 0) runner.remove(out); // checked above: only an earlier run's output

  const frameworksDir = path.join(out, 'xcframeworks');
  const dsymsDir = path.join(out, 'dSYMs');
  const releaseDir = path.join(out, 'release');

  // --- Per xcframework: prune, dSYMs, strip, stamp ------------------------------------------
  runner.mkdir(dsymsDir); // the dSYMs zip needs it even when no binary has symbols
  for (const job of jobs) {
    const kept = job.keep.map((l) => l.id).join(', ');
    const pruned = job.drop.map((l) => l.id).join(', ') || 'nothing';
    runner.step(`${job.name}${job.vendored ? ' (vendored)' : ''}: keep ${kept}; prune ${pruned}`);
    const staged = path.join(frameworksDir, job.name);
    runner.mkdir(staged);
    for (const entry of job.shared)
      runner.run('ditto', [path.join(job.dir, entry), path.join(staged, entry)]);

    for (const lib of job.keep) {
      const sliceSrc = path.join(job.dir, lib.id);
      const sliceDst = path.join(staged, lib.id);
      for (const entry of fs.readdirSync(sliceSrc).sort()) {
        if (entry === lib.debugSymbolsPath || entry === '.DS_Store') continue;
        runner.run('ditto', [path.join(sliceSrc, entry), path.join(sliceDst, entry)]);
      }
      const binary = path.join(sliceDst, lib.binaryPath);
      const dsymDst = path.join(dsymsDir, job.name, lib.id);
      const shippedDsyms = lib.debugSymbolsPath ? path.join(sliceSrc, lib.debugSymbolsPath) : null;
      if (shippedDsyms && fs.existsSync(shippedDsyms)) {
        runner.run('ditto', [shippedDsyms, dsymDst]);
      } else if (debugMapOf(runner, binary)) {
        // Before strip: dsymutil reads the debug map strip removes.
        runner.run('dsymutil', [
          binary,
          '-o',
          path.join(dsymDst, `${path.basename(lib.libraryPath)}.dSYM`),
        ]);
      } else {
        console.log(`# ${job.name}/${lib.id}: no debug map (prebuilt binary), so no dSYM`);
      }
      if (lib.archs.length > 0) runner.inspect('lipo', [binary, '-verify_arch', ...lib.archs]);
      runner.run('strip', ['-x', binary]);

      if (job.name === 'PulseKit.xcframework') {
        const plist = path.join(sliceDst, lib.libraryPath, 'Info.plist');
        runner.run('plutil', ['-convert', 'xml1', plist]);
        const stamped = dryRun ? '' : stampPlist(fs.readFileSync(plist, 'utf8'), stamps);
        runner.writeFile(plist, stamped, `stamps ${STAMP_KEYS.map(([key]) => key).join(', ')}`);
      }
    }
    runner.writeFile(
      path.join(staged, 'Info.plist'),
      buildPlist(prunedManifest(job.manifest, job.keep)),
      `AvailableLibraries: ${kept}`,
    );
    for (const dest of job.privacy?.destinations ?? []) {
      runner.writeFile(path.join(staged, dest), job.privacy?.xml ?? '', 'privacy manifest (K2)');
    }
  }

  // --- What ships has no unsafe symlinks ------------------------------------------------------
  runner.step('Check the packaged xcframeworks');
  if (!dryRun) {
    const unsafe = findUnsafeSymlinks(frameworksDir);
    if (unsafe.length > 0) {
      throw new Error(
        `Unsafe symlinks:\n  ${describeUnsafeSymlinks('xcframeworks', unsafe).join('\n  ')}`,
      );
    }
  } else {
    console.log('# (symlinks are checked again on the packaged copies in a real run)');
  }

  // --- Sign: last, because any change inside an xcframework breaks its signature ---------------
  if (values.sign) {
    runner.step(`Sign every xcframework (codesign --timestamp) as ${values.sign}`);
    const keychain = values.keychain ? ['--keychain', path.resolve(values.keychain)] : [];
    for (const job of jobs) {
      const staged = path.join(frameworksDir, job.name);
      runner.run('codesign', [
        '--force',
        '--timestamp',
        '--sign',
        values.sign,
        ...keychain,
        staged,
      ]);
      runner.inspect('codesign', ['--verify', '--strict', '--verbose=2', staged]);
    }
  } else {
    console.log('# not signed (no --sign); a release signs with the distribution identity');
  }

  // --- Zips, SHA256SUMS, size report --------------------------------------------------------
  runner.step('Zip, checksum and size report');
  runner.mkdir(releaseDir);
  const zips = jobs.map((job) => {
    const zip = path.join(releaseDir, `${job.name}.zip`);
    runner.run('ditto', [...ZIP_FLAGS, path.join(frameworksDir, job.name), zip]);
    return { job, zip };
  });
  // Without --keepParent: the xcframeworks sit at the zip's top level, where the podspec's
  // `vendored_frameworks = '*.xcframework'` looks.
  const allZip = path.join(releaseDir, XCFRAMEWORKS_ZIP);
  runner.run('ditto', [...ZIP_FLAGS.filter((f) => f !== '--keepParent'), frameworksDir, allZip]);
  const dsymsZip = path.join(releaseDir, DSYMS_ZIP);
  runner.run('ditto', [...ZIP_FLAGS, dsymsDir, dsymsZip]);
  const attached = attachments.map((file) => {
    const dest = path.join(releaseDir, path.basename(file));
    runner.run('ditto', [file, dest]);
    return dest;
  });

  const assets = [...zips.map((z) => z.zip), allZip, dsymsZip, ...attached];
  runner.writeFile(
    path.join(releaseDir, 'SHA256SUMS'),
    dryRun
      ? ''
      : formatSha256Sums(
          assets.map((file) => ({ name: path.basename(file), sha256: sha256File(file) })),
        ),
    `SHA-256 of ${assets.length} assets (a zip's = swift package compute-checksum)`,
  );

  const report = buildSizeReport([
    ...zips.map(({ job, zip }) => {
      const device = job.keep.find((l) => l.kind === 'device');
      const staged = path.join(frameworksDir, job.name);
      return {
        name: job.name,
        zipBytes: fileSize(zip),
        unpackedBytes: treeSize(staged),
        deviceBinaryBytes: device
          ? fileSize(path.join(staged, device.id, device.binaryPath))
          : null,
      };
    }),
    {
      name: 'dSYMs',
      zipBytes: fileSize(dsymsZip),
      unpackedBytes: treeSize(dsymsDir),
      deviceBinaryBytes: null,
    },
  ]);
  runner.writeFile(
    path.join(releaseDir, 'size-report.md'),
    formatSizeReport(report, {
      title: `PulseKit ${stamps.version} (${stamps.build}) iOS size report`,
    }),
    'Markdown table: zip, unpacked and device binary per xcframework',
  );
  runner.writeFile(
    path.join(releaseDir, 'size-report.json'),
    `${JSON.stringify({ stamps, ...report }, null, 2)}\n`,
    'the same numbers and the stamps, as JSON',
  );
  if (!dryRun) process.stdout.write(`\n${formatSizeReport(report)}`);
  console.log(`\n${dryRun ? 'Dry run: nothing written.' : `Done: ${releaseDir}`}`);
}

try {
  main();
} catch (err) {
  console.error(`package-ios: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
