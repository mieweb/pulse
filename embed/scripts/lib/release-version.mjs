// @ts-check
// The release version and the lockstep rule (AD18): PulseKit, @mieweb/pulse-embed and the plugin
// packages carry one version, which a PulseKit release takes from its `pulsekit-v<version>` tag.
//
// The release workflow stamps that version into the embed packages, embed/app.json and the Cordova
// plugin.xml inside its own checkout (nothing is committed), then checks after packaging that the
// tag, every package and PulseKit.framework's Info.plist agree.
//
// One exception, the marketing version: App Store Connect takes only `X.Y.Z` (at most three
// integers) for CFBundleShortVersionString, in embedded frameworks too (ITMS-90060), so a host
// that embeds an RC PulseKit would fail its upload. expo-brownfield sets PulseKit's
// CFBundleShortVersionString from app.json's `expo.ios.version` (falling back to `expo.version`),
// so stamping writes the numeric core there and the full version (with -rc.N) everywhere else,
// including PulseKitVersion. The check runs only in that tag
// workflow, never on PRs, so an app release PR that bumps the root version can't turn CI red.

import fs from 'node:fs';
import path from 'node:path';

import { parsePlist, rootDict } from './plist.mjs';

export const TAG_PREFIX = 'pulsekit-v';

/** Where the embed's npm packages live; each folder with a package.json is one. */
const PACKAGES_DIR = 'embed/packages';
const APP_JSON = 'embed/app.json';
const CORDOVA_PLUGIN_XML = 'embed/packages/cordova-plugin-pulse/plugin.xml';

const NUM = '(0|[1-9]\\d*)';
const TAG_RE = new RegExp(`^${TAG_PREFIX}(${NUM}\\.${NUM}\\.${NUM})(?:-rc\\.([1-9]\\d*))?$`);

/**
 * @typedef {object} ReleaseTag
 * @property {string} tag         The tag as given.
 * @property {string} version     `1.2.3` or `1.2.3-rc.4`.
 * @property {number | null} rc   The release-candidate number, or null for a final release.
 * @property {boolean} prerelease Whether GitHub marks the release as a prerelease.
 * @property {'rc' | 'latest'} distTag The npm dist-tag the packages publish under.
 */

/**
 * Reads a release tag: `pulsekit-v<major>.<minor>.<patch>` for a final release, with `-rc.<n>`
 * (n ≥ 1) for a release candidate. Anything else throws, so a typo can't publish.
 * @param {string} tag
 * @returns {ReleaseTag}
 */
export function parseReleaseTag(tag) {
  const m = TAG_RE.exec(tag);
  if (!m) {
    throw new Error(
      `"${tag}" is not a PulseKit release tag: expected ${TAG_PREFIX}<major>.<minor>.<patch> ` +
        `or ${TAG_PREFIX}<major>.<minor>.<patch>-rc.<n>`,
    );
  }
  const rc = m[5] === undefined ? null : Number(m[5]);
  const version = rc === null ? m[1] : `${m[1]}-rc.${rc}`;
  return { tag, version, rc, prerelease: rc !== null, distTag: rc === null ? 'latest' : 'rc' };
}

/**
 * Checks a version before a generator writes it into Package.swift or the podspec. Release
 * versions come from `parseReleaseTag`; this also takes the `0.0.0-dev` placeholder.
 * @param {string} version
 */
export function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`"${version}" is not a semver version`);
  }
  return version;
}

/**
 * The marketing version (CFBundleShortVersionString) for a release version: its numeric core,
 * `2.8.0` for both `2.8.0` and `2.8.0-rc.3`.
 * @param {string} version
 */
export function marketingVersion(version) {
  return assertVersion(version).split('-')[0];
}

/**
 * The embed's npm package.json files, relative to the repo, sorted.
 * @param {string} repoRoot
 */
export function packageFiles(repoRoot) {
  const dir = path.join(repoRoot, PACKAGES_DIR);
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'package.json')))
    .map((e) => `${PACKAGES_DIR}/${e.name}/package.json`)
    .sort();
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @param {string} file @param {unknown} value */
function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** The plugin element's version attribute in plugin.xml. */
const PLUGIN_VERSION_RE = /(<plugin\b[^>]*?\sversion=")([^"]*)(")/;

/**
 * Writes `version` into every embed package.json, embed/app.json (`expo.version`) and the Cordova
 * plugin.xml, and its marketing version into app.json's `expo.ios.version` (what PulseKit's
 * CFBundleShortVersionString comes from). Returns the files it wrote, relative to the repo.
 * @param {string} repoRoot
 * @param {string} version
 */
export function stampVersion(repoRoot, version) {
  assertVersion(version);
  /** @type {string[]} */
  const written = [];
  for (const rel of packageFiles(repoRoot)) {
    const file = path.join(repoRoot, rel);
    const pkg = readJson(file);
    pkg.version = version;
    writeJson(file, pkg);
    written.push(rel);
  }

  const appFile = path.join(repoRoot, APP_JSON);
  const app = readJson(appFile);
  if (!app.expo || typeof app.expo !== 'object') throw new Error(`${APP_JSON} has no "expo" key`);
  app.expo.version = version;
  app.expo.ios = { ...app.expo.ios, version: marketingVersion(version) };
  writeJson(appFile, app);
  written.push(APP_JSON);

  const xmlFile = path.join(repoRoot, CORDOVA_PLUGIN_XML);
  if (fs.existsSync(xmlFile)) {
    const xml = fs.readFileSync(xmlFile, 'utf8');
    if (!PLUGIN_VERSION_RE.test(xml)) {
      throw new Error(`${CORDOVA_PLUGIN_XML}: no version attribute on <plugin>`);
    }
    fs.writeFileSync(xmlFile, xml.replace(PLUGIN_VERSION_RE, `$1${version}$3`));
    written.push(CORDOVA_PLUGIN_XML);
  }
  return written;
}

/**
 * One place a version lives. `marketing` marks a CFBundleShortVersionString-style value, which
 * must be the tag's numeric core (`marketingVersion`) rather than the full version.
 * @typedef {{ file: string, version: string | null, marketing?: boolean }} FoundVersion
 */

/**
 * Where the lockstep version lives in the checkout: each embed package, embed/app.json
 * (`expo.version`, and `expo.ios.version` as the marketing version) and the Cordova plugin.xml.
 * Values are as found (null when the field is missing).
 * @param {string} repoRoot
 * @returns {FoundVersion[]}
 */
export function readStampedVersions(repoRoot) {
  /** @type {FoundVersion[]} */
  const found = packageFiles(repoRoot).map((rel) => ({
    file: rel,
    version: readJson(path.join(repoRoot, rel)).version ?? null,
  }));
  const app = readJson(path.join(repoRoot, APP_JSON));
  found.push({ file: APP_JSON, version: app.expo?.version ?? null });
  found.push({
    file: `${APP_JSON} expo.ios.version`,
    version: app.expo?.ios?.version ?? null,
    marketing: true,
  });
  const xmlFile = path.join(repoRoot, CORDOVA_PLUGIN_XML);
  if (fs.existsSync(xmlFile)) {
    const m = PLUGIN_VERSION_RE.exec(fs.readFileSync(xmlFile, 'utf8'));
    found.push({ file: CORDOVA_PLUGIN_XML, version: m ? m[2] : null });
  }
  return found;
}

/**
 * The PulseKitVersion and CFBundleShortVersionString (`marketing`) in each PulseKit.framework
 * Info.plist under a packaged xcframeworks folder (package-ios.mjs's `<out>/xcframeworks`; it
 * leaves those plists as XML).
 * @param {string} xcframeworksDir
 * @returns {FoundVersion[]}
 */
export function readPulseKitVersions(xcframeworksDir) {
  const xcframework = path.join(xcframeworksDir, 'PulseKit.xcframework');
  if (!fs.existsSync(xcframework)) throw new Error(`no PulseKit.xcframework in ${xcframeworksDir}`);
  return fs
    .readdirSync(xcframework, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_CodeSignature')
    .map((e) => path.join(xcframework, e.name, 'PulseKit.framework', 'Info.plist'))
    .filter((file) => fs.existsSync(file))
    .sort()
    .flatMap((file) => {
      const dict = rootDict(parsePlist(fs.readFileSync(file, 'utf8')));
      const text = (/** @type {string} */ key) => {
        const value = dict.get(key);
        return typeof value === 'string' ? value : null;
      };
      const rel = path.relative(xcframeworksDir, file);
      return [
        { file: rel, version: text('PulseKitVersion') },
        {
          file: `${rel} CFBundleShortVersionString`,
          version: text('CFBundleShortVersionString'),
          marketing: true,
        },
      ];
    });
}

/**
 * Every place whose version is not the tag's (its numeric core for a `marketing` value). Empty
 * when the release is in lockstep. Also a problem: no PulseKit Info.plist at all (`pulseKit`
 * given but empty).
 * @param {string} version  The tag's version.
 * @param {FoundVersion[]} stamped  From `readStampedVersions`.
 * @param {FoundVersion[]} [pulseKit]  From `readPulseKitVersions`.
 */
export function lockstepProblems(version, stamped, pulseKit) {
  const core = marketingVersion(version);
  /** @type {string[]} */
  const problems = [];
  for (const s of [...stamped, ...(pulseKit ?? [])]) {
    const want = s.marketing ? core : version;
    if (s.version !== want) problems.push(`${s.file} is ${s.version ?? '(none)'}, not ${want}`);
  }
  if (pulseKit && pulseKit.length === 0) problems.push('no PulseKit.framework Info.plist to check');
  return problems;
}

/**
 * Why an embed package can't publish with provenance: npm checks `repository.url` against the
 * repository the build ran in and rejects the publish when they differ (or it's missing), and a
 * private package doesn't publish at all. Empty when every package can publish.
 * @param {string} repoRoot
 * @param {string} repository  `owner/name` ($GITHUB_REPOSITORY).
 */
export function publishProblems(repoRoot, repository) {
  const want = `https://github.com/${repository}`.toLowerCase();
  /** @type {string[]} */
  const problems = [];
  for (const rel of packageFiles(repoRoot)) {
    const pkg = readJson(path.join(repoRoot, rel));
    if (pkg.private) problems.push(`${rel}: "private": true`);
    const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const url =
      typeof raw === 'string'
        ? raw
            .replace(/^git\+/, '')
            .replace(/\.git$/, '')
            .toLowerCase()
        : null;
    if (url !== want) {
      problems.push(`${rel}: repository.url is ${raw ?? '(none)'}; provenance needs ${want}`);
    }
  }
  return problems;
}

/**
 * The workflow's entry point (libraries here have no CLI file of their own):
 *   tag <tag>                 print version=, dist_tag=, prerelease= lines ($GITHUB_OUTPUT form)
 *   stamp <version>           write the version into the packages, app.json and plugin.xml
 *   publishable <owner/name>  fail unless every package can publish with provenance
 *   lockstep <version> <xcframeworks dir>  fail unless the packages and PulseKit carry <version>
 * Run from the repo root: `node -e "import('./embed/scripts/lib/release-version.mjs')
 *   .then((m) => m.cli(process.argv.slice(1)))" <command> <args>`.
 * @param {readonly string[]} argv
 * @param {{ repoRoot?: string, out?: (line: string) => void }} [options]
 */
export function cli(argv, options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const out = options.out ?? ((line) => console.log(line));
  const [command, ...args] = argv;
  const fail = (/** @type {string} */ what, /** @type {string[]} */ problems) => {
    throw new Error(`${what}:\n  ${problems.join('\n  ')}`);
  };
  switch (command) {
    case 'tag': {
      const t = parseReleaseTag(args[0] ?? '');
      out(`version=${t.version}`);
      out(`dist_tag=${t.distTag}`);
      out(`prerelease=${t.prerelease}`);
      return;
    }
    case 'stamp':
      for (const file of stampVersion(repoRoot, args[0] ?? '')) out(`stamped ${file}`);
      return;
    case 'publishable': {
      const problems = publishProblems(repoRoot, args[0] ?? '');
      if (problems.length > 0) fail("These packages can't publish with provenance", problems);
      return;
    }
    case 'lockstep': {
      const [version, dir] = args;
      if (!version || !dir) throw new Error('usage: lockstep <version> <xcframeworks dir>');
      const problems = lockstepProblems(
        version,
        readStampedVersions(repoRoot),
        readPulseKitVersions(path.resolve(repoRoot, dir)),
      );
      if (problems.length > 0) fail(`Not in lockstep with ${version}`, problems);
      out(`lockstep: every package and PulseKit carry ${version}`);
      return;
    }
    default:
      throw new Error(`unknown command "${command}" (tag, stamp, publishable, lockstep)`);
  }
}
