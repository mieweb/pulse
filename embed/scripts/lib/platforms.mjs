// Which slices of an xcframework PulseKit ships: iOS devices and the iOS Simulator. The others
// (macOS, Mac Catalyst, tvOS, visionOS, watchOS) are pruned. hermesvm's macOS and Catalyst slices
// are the ones whose symlinks point into the producer's Pods folder, so pruning them is also how
// hermesvm gets rebuilt from its device and simulator slices.

import path from 'node:path';

import { rootDict } from './plist.mjs';

/**
 * @typedef {object} Library  One AvailableLibraries entry of an xcframework's Info.plist.
 * @property {string} id            LibraryIdentifier, which is also the slice's folder name.
 * @property {string} libraryPath   LibraryPath inside the slice folder (X.framework or libX.a).
 * @property {string} binaryPath    The Mach-O file inside the slice folder.
 * @property {string | null} debugSymbolsPath DebugSymbolsPath (a dSYMs folder), when present.
 * @property {string} platform      SupportedPlatform.
 * @property {string | null} variant SupportedPlatformVariant ('simulator', 'maccatalyst').
 * @property {string[]} archs       SupportedArchitectures.
 * @property {'device' | 'simulator' | null} kind What PulseKit keeps it as; null is pruned.
 */

/** @param {Map<string, import('./plist.mjs').PlistValue>} dict @param {string} key */
function text(dict, key) {
  const v = dict.get(key);
  return typeof v === 'string' ? v : null;
}

/**
 * The binary inside a library. BinaryPath is optional (whisper.rn's manifest leaves it out); a
 * framework's binary is then X.framework/X.
 * @param {string} libraryPath @param {string | null} binaryPath
 */
function binaryOf(libraryPath, binaryPath) {
  if (binaryPath) return binaryPath;
  if (libraryPath.endsWith('.framework')) {
    return `${libraryPath}/${path.basename(libraryPath, '.framework')}`;
  }
  return libraryPath;
}

/**
 * Lists an xcframework's libraries from its parsed Info.plist.
 * @param {import('./plist.mjs').PlistValue} manifest
 * @returns {Library[]}
 */
export function listLibraries(manifest) {
  const libs = rootDict(manifest).get('AvailableLibraries');
  if (!Array.isArray(libs)) throw new Error('xcframework Info.plist has no AvailableLibraries');
  return libs.map((entry) => {
    const dict = rootDict(entry);
    const id = text(dict, 'LibraryIdentifier');
    const libraryPath = text(dict, 'LibraryPath');
    const platform = text(dict, 'SupportedPlatform');
    if (!id || !libraryPath || !platform) {
      throw new Error(
        'an AvailableLibraries entry lacks LibraryIdentifier, LibraryPath or SupportedPlatform',
      );
    }
    const variant = text(dict, 'SupportedPlatformVariant');
    const archs = dict.get('SupportedArchitectures');
    /** @type {Library['kind']} */
    let kind = null;
    if (platform === 'ios' && variant === null) kind = 'device';
    else if (platform === 'ios' && variant === 'simulator') kind = 'simulator';
    return {
      id,
      libraryPath,
      binaryPath: binaryOf(libraryPath, text(dict, 'BinaryPath')),
      debugSymbolsPath: text(dict, 'DebugSymbolsPath'),
      platform,
      variant,
      archs: Array.isArray(archs) ? archs.filter((a) => typeof a === 'string') : [],
      kind,
    };
  });
}

/**
 * Splits an xcframework's libraries into the iOS device and simulator slices PulseKit keeps and
 * the rest. Fails unless there is exactly one of each kept kind: a host needs both.
 * @param {string} name  The xcframework's file name, for messages.
 * @param {import('./plist.mjs').PlistValue} manifest
 */
export function planSlices(name, manifest) {
  const all = listLibraries(manifest);
  const keep = all.filter((l) => l.kind !== null);
  const drop = all.filter((l) => l.kind === null);
  for (const kind of /** @type {const} */ (['device', 'simulator'])) {
    const n = keep.filter((l) => l.kind === kind).length;
    if (n !== 1) throw new Error(`${name}: expected one iOS ${kind} slice, found ${n}`);
  }
  return { keep, drop };
}

/**
 * The Info.plist for the pruned xcframework: only the kept libraries, in their original order,
 * and without DebugSymbolsPath, because the dSYMs ship separately (K4).
 * @param {import('./plist.mjs').PlistValue} manifest
 * @param {Library[]} keep
 */
export function prunedManifest(manifest, keep) {
  const ids = new Set(keep.map((l) => l.id));
  const root = new Map(rootDict(manifest));
  const libs = /** @type {import('./plist.mjs').PlistValue[]} */ (root.get('AvailableLibraries'));
  root.set(
    'AvailableLibraries',
    libs
      .map((entry) => rootDict(entry))
      .filter((dict) => ids.has(/** @type {string} */ (dict.get('LibraryIdentifier'))))
      .map((dict) => {
        const copy = new Map(dict);
        copy.delete('DebugSymbolsPath');
        return copy;
      }),
  );
  return root;
}

/**
 * Top-level entries of an xcframework folder that are copied as they are: everything except the
 * slice folders, Info.plist (rewritten) and _CodeSignature (pruning invalidates the signature;
 * K2 signs the shipped xcframeworks again).
 * @param {string[]} entries  The folder's entry names.
 * @param {Library[]} all     Every library in the manifest.
 */
export function sharedEntries(entries, all) {
  const slices = new Set(all.map((l) => l.id));
  return entries
    .filter(
      (e) => !slices.has(e) && e !== 'Info.plist' && e !== '_CodeSignature' && e !== '.DS_Store',
    )
    .sort();
}

/**
 * The framework name a library provides to `@rpath` (`X` for X.framework), or null for a static
 * library.
 * @param {Library} lib
 */
export function frameworkName(lib) {
  return lib.libraryPath.endsWith('.framework')
    ? path.basename(lib.libraryPath, '.framework')
    : null;
}
