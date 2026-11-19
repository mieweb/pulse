// @ts-check
// THIRD_PARTY_NOTICES for a PulseKit release: the license of everything PulseKit is built from.
//   - npm packages: the embed app's dependencies (embed/package.json) and the local native modules
//     (embed/package.json expo.autolinking.nativeModulesDir), followed through their
//     `dependencies` and `optionalDependencies` as Node resolves them. That also takes in some
//     build-time tooling (expo's CLI, for one): a notice too many costs nothing, one too few does.
//   - CocoaPods: each pod folder under ios/Pods with a license file (hermes-engine, SSZipArchive).
//   - Prebuilt native frameworks that arrive as binaries with no license file on disk (expo-image's
//     SDWebImage family and libavif, React Native's dependencies): NATIVE_COMPONENTS, by SPDX id
//     and source URL.
// The output is sorted, so the same inputs give the same file.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} NoticeEntry
 * @property {string} name
 * @property {string | null} version
 * @property {string} license      SPDX expression, or what the package declares.
 * @property {string | null} url   Where the source and license live.
 * @property {string | null} text  The license file's text, when one was found.
 */

/** Binaries in the release whose license text isn't on disk at build time. */
export const NATIVE_COMPONENTS = /** @type {const} */ ([
  { name: 'SDWebImage', license: 'MIT', url: 'https://github.com/SDWebImage/SDWebImage' },
  {
    name: 'SDWebImageAVIFCoder',
    license: 'MIT',
    url: 'https://github.com/SDWebImage/SDWebImageAVIFCoder',
  },
  {
    name: 'SDWebImageSVGCoder',
    license: 'MIT',
    url: 'https://github.com/SDWebImage/SDWebImageSVGCoder',
  },
  {
    name: 'SDWebImageWebPCoder',
    license: 'MIT',
    url: 'https://github.com/SDWebImage/SDWebImageWebPCoder',
  },
  { name: 'libavif', license: 'BSD-2-Clause', url: 'https://github.com/AOMediaCodec/libavif' },
  // expo-image builds libavif with dav1d (its Podfile property expo-image.disable-libdav1d).
  { name: 'dav1d', license: 'BSD-2-Clause', url: 'https://code.videolan.org/videolan/dav1d' },
  {
    name: 'libwebp',
    license: 'BSD-3-Clause',
    url: 'https://chromium.googlesource.com/webm/libwebp',
  },
  { name: 'folly', license: 'Apache-2.0', url: 'https://github.com/facebook/folly' },
  { name: 'glog', license: 'BSD-3-Clause', url: 'https://github.com/google/glog' },
  { name: 'boost', license: 'BSL-1.0', url: 'https://www.boost.org' },
  {
    name: 'double-conversion',
    license: 'BSD-3-Clause',
    url: 'https://github.com/google/double-conversion',
  },
  {
    name: 'fast_float',
    license: 'Apache-2.0 OR MIT OR BSL-1.0',
    url: 'https://github.com/fastfloat/fast_float',
  },
  { name: 'fmt', license: 'MIT', url: 'https://github.com/fmtlib/fmt' },
  {
    name: 'SocketRocket',
    license: 'BSD-3-Clause',
    url: 'https://github.com/facebookincubator/SocketRocket',
  },
]);

const LICENSE_FILE = /^(licen[cs]e|copying|unlicense)([.-].*)?$/i;
const NOTICE_FILE = /^notice([.-].*)?$/i;

/** @param {string} a @param {string} b */
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The text of the license (and NOTICE, for Apache-style packages) files at the top of `dir`, in
 * name order, or null when it has none.
 * @param {string} dir
 */
export function licenseText(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).sort(byText);
  } catch {
    return null;
  }
  const files = [
    ...names.filter((n) => LICENSE_FILE.test(n)),
    ...names.filter((n) => NOTICE_FILE.test(n)),
  ].filter((n) => fs.statSync(path.join(dir, n)).isFile());
  if (files.length === 0) return null;
  return files.map((n) => fs.readFileSync(path.join(dir, n), 'utf8').trim()).join('\n\n');
}

/** @param {any} pkg */
function declaredLicense(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses.map((/** @type {any} */ l) => l?.type ?? l).filter(Boolean);
    if (types.length > 0) return types.join(' OR ');
  }
  return 'UNKNOWN';
}

/** @param {any} pkg */
function repositoryUrl(pkg) {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (typeof raw === 'string') return raw.replace(/^git\+/, '');
  return typeof pkg.homepage === 'string' ? pkg.homepage : null;
}

/**
 * Finds where `name` resolves from `fromDir`, the way Node does: `node_modules/<name>` in that
 * folder and then each parent, up to and including `stopDir`.
 * @param {string} name @param {string} fromDir @param {string} stopDir
 */
export function resolvePackageDir(name, fromDir, stopDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.resolve(dir) === path.resolve(stopDir)) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Every npm package reachable from the given roots' `dependencies` and `optionalDependencies`,
 * one entry per name and version, sorted. A required dependency that doesn't resolve is reported
 * in `missing` (an optional one is skipped: npm leaves out other platforms' builds).
 * @param {readonly string[]} roots  Folders with a package.json whose dependencies ship.
 * @param {string} stopDir           The folder resolution stops at (the repo).
 */
export function collectNpmPackages(roots, stopDir) {
  /** @type {Map<string, NoticeEntry>} */
  const found = new Map();
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {Set<string>} */
  const missing = new Set();

  /** @param {string} dir @param {boolean} isRoot */
  const visit = (dir, isRoot) => {
    const real = fs.realpathSync(dir);
    if (visited.has(real)) return;
    visited.add(real);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (!isRoot) {
      const key = `${pkg.name}@${pkg.version}`;
      if (!found.has(key)) {
        found.set(key, {
          name: pkg.name,
          version: pkg.version ?? null,
          license: declaredLicense(pkg),
          url: repositoryUrl(pkg),
          text: licenseText(dir),
        });
      }
    }
    const required = Object.keys(pkg.dependencies ?? {});
    const optional = Object.keys(pkg.optionalDependencies ?? {});
    for (const name of [...new Set([...required, ...optional])].sort(byText)) {
      const at = resolvePackageDir(name, dir, stopDir);
      if (at) visit(at, false);
      else if (!optional.includes(name)) missing.add(`${name} (from ${pkg.name ?? dir})`);
    }
  };
  for (const root of roots) visit(root, true);

  const packages = [...found.values()].sort(
    (a, b) => byText(a.name, b.name) || byText(a.version ?? '', b.version ?? ''),
  );
  return { packages, missing: [...missing].sort(byText) };
}

/**
 * The CocoaPods under a Pods folder that carry a license file, sorted by name.
 * @param {string} podsDir
 * @returns {NoticeEntry[]}
 */
export function collectPods(podsDir) {
  if (!fs.existsSync(podsDir)) return [];
  return fs
    .readdirSync(podsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, text: licenseText(path.join(podsDir, e.name)) }))
    .filter((p) => p.text !== null)
    .sort((a, b) => byText(a.name, b.name))
    .map((p) => ({ name: p.name, version: null, license: 'see text', url: null, text: p.text }));
}

/** @param {string} text */
function fence(text) {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}text\n${text}\n${ticks}`;
}

/** @param {NoticeEntry} e */
function section(e) {
  const head = `### ${e.name}${e.version ? ` ${e.version}` : ''}`;
  const meta = [`License: ${e.license}`, e.url ? `Source: ${e.url}` : null].filter(Boolean);
  const body = e.text ? fence(e.text) : 'No license file in the package; see the source above.';
  return `${head}\n\n${meta.join('  \n')}\n\n${body}\n`;
}

/**
 * The THIRD_PARTY_NOTICES document.
 * @param {{ title: string, packages: NoticeEntry[], pods: NoticeEntry[],
 *   native?: readonly { name: string, license: string, url: string }[] }} input
 */
export function formatNotices({ title, packages, pods, native = NATIVE_COMPONENTS }) {
  const nativeEntries = [...native]
    .sort((a, b) => byText(a.name, b.name))
    .map((n) => ({ ...n, version: null, text: null }));
  const parts = [
    `# ${title}`,
    '',
    'PulseKit includes the software listed below. Each entry gives its license and, where the',
    'license file was available at build time, its full text.',
    '',
    `## npm packages (${packages.length})`,
    '',
    ...packages.map(section),
    `## CocoaPods (${pods.length})`,
    '',
    ...pods.map(section),
    `## Prebuilt native frameworks (${nativeEntries.length})`,
    '',
    ...nativeEntries.map((e) => `### ${e.name}\n\nLicense: ${e.license}  \nSource: ${e.url}\n`),
  ];
  return `${parts.join('\n').trimEnd()}\n`;
}
