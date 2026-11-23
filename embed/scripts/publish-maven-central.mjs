#!/usr/bin/env node
// Publishes PulseKit's Android Maven repository to Maven Central through the Central Publisher
// API (O5): checks every publication against Central's rules, writes the checksums, signs every
// file with gpg, zips the bundle in Maven layout, uploads it and polls the deployment until
// Central has validated it (USER_MANAGED) or is publishing it (AUTOMATIC), or it failed.
//
// The repository is the one in PulseKit-android-maven.zip on the GitHub Release, after
// complete-android-metadata.mjs gave its POM the fields Central requires. Release candidates are
// refused: Central versions can't be deleted, so they stay on the GitHub Release (Q-A5).
// The rules live in lib/maven-central.mjs; this file does the IO.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { findPublications, repositoryProblems, zipFiles } from './lib/android-aar.mjs';
import {
  assertCentralVersion,
  bundlePlan,
  centralPomProblems,
  CHECKSUM_ALGORITHMS,
  checksumsOf,
  parseStatus,
  parseUploadResponse,
  placeholderJar,
  PUBLISHING_TYPES,
  statusRequest,
  uploadRequest,
} from './lib/maven-central.mjs';

const HELP = `Usage: node embed/scripts/publish-maven-central.mjs [options]

Builds a Maven Central bundle from PulseKit's Android Maven repository (checksums, gpg
signatures, placeholder -sources and -javadoc jars where the build wrote none), uploads it to the
Central Publisher API and waits for the deployment's verdict.

Options:
  --maven <dir>            The Maven repository (default: embed/artifacts/android-maven), after
                           complete-android-metadata.mjs.
  --bundle <file>          Where to write the bundle zip (default: a temporary file).
  --publishing-type <t>    USER_MANAGED (Central validates; someone presses Publish on
                           central.sonatype.com) or AUTOMATIC (Central publishes once valid).
                           Default: $MAVEN_CENTRAL_PUBLISHING_TYPE, else USER_MANAGED.
  --name <text>            The deployment's name in the portal (default: the coordinates).
  --timeout-minutes <n>    How long to wait for a verdict (default: 30).
  --dry-run                Build and check the bundle; upload nothing. Signs only when a key is
                           set.
  -h, --help               Show this help.

Environment:
  MAVEN_CENTRAL_USERNAME, MAVEN_CENTRAL_PASSWORD
                           A Central Portal user token (both halves). Not needed for --dry-run.
  MAVEN_GPG_PRIVATE_KEY    The ASCII-armoured private key that signs (its public key must be on a
                           keyserver Central reads, such as keys.openpgp.org).
  MAVEN_GPG_PASSPHRASE     Its passphrase.
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
 * A gpg that signs with the given key, in a throwaway GNUPGHOME, so the runner's own keyring is
 * never touched. The passphrase goes in on stdin, never in argv.
 * @param {string} key @param {string} passphrase @param {string} home
 */
function createSigner(key, passphrase, home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = { ...process.env, GNUPGHOME: home };
  /** @param {string[]} args @param {string} [input] */
  const gpg = (args, input) =>
    execFileSync('gpg', ['--batch', '--no-tty', ...args], {
      env,
      input: input ?? '',
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  gpg(['--import'], key);
  return {
    /** Writes `<file>.asc` and checks it. @param {string} file */
    sign(file) {
      gpg(
        [
          '--yes',
          '--pinentry-mode',
          'loopback',
          '--passphrase-fd',
          '0',
          '--armor',
          '--detach-sign',
          '--output',
          `${file}.asc`,
          file,
        ],
        passphrase,
      );
      gpg(['--verify', `${file}.asc`, file]);
    },
  };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { values } = parseArgs({
    options: {
      maven: { type: 'string', default: 'embed/artifacts/android-maven' },
      bundle: { type: 'string' },
      'publishing-type': { type: 'string' },
      name: { type: 'string' },
      'timeout-minutes': { type: 'string', default: '30' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const dryRun = values['dry-run'];
  const publishingType = /** @type {import('./lib/maven-central.mjs').PublishingType} */ (
    values['publishing-type'] ?? (process.env.MAVEN_CENTRAL_PUBLISHING_TYPE || 'USER_MANAGED')
  );
  if (!PUBLISHING_TYPES.includes(publishingType)) {
    throw new Error(`--publishing-type ${publishingType}: not one of ${PUBLISHING_TYPES}`);
  }
  const timeoutMinutes = Number(values['timeout-minutes']);
  if (!(timeoutMinutes > 0)) throw new Error('--timeout-minutes must be a positive number');

  const maven = path.resolve(values.maven);
  if (!fs.existsSync(maven) || !fs.statSync(maven).isDirectory()) {
    throw new Error(`--maven ${maven} is not a folder`);
  }
  const key = process.env.MAVEN_GPG_PRIVATE_KEY ?? '';
  const passphrase = process.env.MAVEN_GPG_PASSPHRASE ?? '';
  const username = process.env.MAVEN_CENTRAL_USERNAME ?? '';
  const password = process.env.MAVEN_CENTRAL_PASSWORD ?? '';
  if (!dryRun) {
    const missing = [
      ['MAVEN_CENTRAL_USERNAME', username],
      ['MAVEN_CENTRAL_PASSWORD', password],
      ['MAVEN_GPG_PRIVATE_KEY', key],
    ].filter(([, v]) => !v);
    if (missing.length > 0) throw new Error(`not set: ${missing.map(([n]) => n).join(', ')}`);
  }

  // --- What goes in, checked before anything is written ----------------------------------------
  const files = listFiles(maven);
  const pubs = findPublications(files);
  const problems = repositoryProblems(pubs);
  /** @type {{ pub: import('./lib/android-aar.mjs').Publication,
   *   plan: import('./lib/maven-central.mjs').BundlePlan }[]} */
  const planned = [];
  for (const pub of pubs) {
    const label = `${pub.group}:${pub.artifact}:${pub.version}`;
    try {
      assertCentralVersion(pub.version);
    } catch (err) {
      problems.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const pomProblems = centralPomProblems(fs.readFileSync(path.join(maven, pub.pom), 'utf8'));
    for (const p of pomProblems) {
      problems.push(`${pub.pom}: ${p} (run complete-android-metadata.mjs)`);
    }
    const dirFiles = files
      .filter((f) => f.startsWith(`${pub.dir}/`) && !f.slice(pub.dir.length + 1).includes('/'))
      .map((f) => f.slice(pub.dir.length + 1));
    const plan = bundlePlan(pub, dirFiles);
    problems.push(...plan.problems);
    planned.push({ pub, plan });
  }
  if (problems.length > 0) {
    throw new Error(`Central would refuse ${maven}:\n  ${problems.join('\n  ')}`);
  }
  const coords = pubs.map((p) => `${p.group}:${p.artifact}:${p.version}`);
  console.log(`# publications: ${coords.join(', ')}`);
  console.log(`# publishing type: ${publishingType}${dryRun ? ' (dry run)' : ''}`);

  // --- Stage, checksum, sign, zip ------------------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsekit-central-'));
  try {
    const stage = path.join(tmp, 'bundle');
    const signer = key ? createSigner(key, passphrase, path.join(tmp, 'gnupg')) : null;
    if (!signer) console.log('# no MAVEN_GPG_PRIVATE_KEY: the dry-run bundle is unsigned');

    for (const { pub, plan } of planned) {
      const contents = [
        ...plan.files.map((f) => ({ name: f, data: fs.readFileSync(path.join(maven, f)) })),
        ...plan.placeholders.map((p) => ({
          name: p.path,
          data: placeholderJar(p.kind, `${pub.group}:${pub.artifact}:${pub.version}`),
        })),
      ];
      for (const { name, data } of contents) {
        const file = path.join(stage, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, data);
        const sums = checksumsOf(data);
        for (const a of CHECKSUM_ALGORITHMS) fs.writeFileSync(`${file}.${a}`, sums[a]);
        signer?.sign(file);
      }
      for (const p of plan.placeholders) console.log(`# placeholder ${p.path}`);
    }

    const expected = planned
      .flatMap(({ plan }) => plan.entries)
      .filter((e) => signer || !e.endsWith('.asc'))
      .sort();
    const staged = listFiles(stage);
    if (JSON.stringify(staged) !== JSON.stringify(expected)) {
      throw new Error(
        `the staged bundle doesn't match the plan:\n  staged:   ${staged.join(', ')}\n` +
          `  expected: ${expected.join(', ')}`,
      );
    }
    const bundle = zipFiles(
      staged.map((name) => ({ name, data: fs.readFileSync(path.join(stage, name)) })),
    );
    const bundlePath = path.resolve(values.bundle ?? path.join(tmp, 'central-bundle.zip'));
    fs.writeFileSync(bundlePath, bundle);
    console.log(`# bundle: ${staged.length} files, ${bundle.length} bytes`);

    if (dryRun) {
      console.log(
        `Dry run: ${values.bundle ? `bundle written to ${bundlePath}` : 'bundle built'}, ` +
          'not uploaded.',
      );
      return;
    }

    // --- Upload and wait for the verdict ---------------------------------------------------
    const upload = uploadRequest({
      username,
      password,
      bundle,
      name: values.name ?? coords.join(', '),
      publishingType,
    });
    const res = await fetch(upload.url, upload.init);
    const id = parseUploadResponse(res.status, await res.text());
    console.log(`# deployment ${id}`);

    const deadline = Date.now() + timeoutMinutes * 60_000;
    for (;;) {
      const req = statusRequest({ username, password, id });
      const r = await fetch(req.url, req.init);
      if (!r.ok) throw new Error(`status of ${id}: HTTP ${r.status} ${await r.text()}`);
      const status = parseStatus(await r.json(), publishingType);
      console.log(`# ${new Date().toISOString()} ${status.message}`);
      if (status.done) {
        for (const e of status.errors) console.log(`#   ${e}`);
        if (!status.ok) throw new Error(`deployment ${id} ${status.state}`);
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `deployment ${id} is still ${status.state} after ${timeoutMinutes} minutes; ` +
            'see central.sonatype.com (Deployments)',
        );
      }
      await sleep(15_000);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`publish-maven-central: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
