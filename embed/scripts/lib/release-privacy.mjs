// @ts-check
// K2: the privacy manifests PulseKit ships. Apple's privacy report reads a PrivacyInfo.xcprivacy at
// the root of each framework, and hermes and SDWebImage are on Apple's list of SDKs that must carry
// one (and a signature). The brownfield build leaves them out, so package-ios.mjs writes one into
// every kept slice of these xcframeworks. PulseKit's own (embed/native/ios) is also copied into
// the PulseKit target by plugins/with-pulsekit-facade.js; writing it here too makes what ships
// equal the committed file whichever way the framework was built.

import { parsePlist, rootDict } from './plist.mjs';

export const PRIVACY_FILE = 'PrivacyInfo.xcprivacy';

/** xcframework → its manifest's source, relative to the repo. */
export const PRIVACY_MANIFESTS = /** @type {const} */ ({
  'PulseKit.xcframework': 'embed/native/ios/PrivacyInfo.xcprivacy',
  'SDWebImage.xcframework': 'embed/scripts/privacy/SDWebImage.xcprivacy',
  'hermesvm.xcframework': 'embed/scripts/privacy/hermesvm.xcprivacy',
  'rnwhisper.xcframework': 'embed/scripts/privacy/rnwhisper.xcprivacy',
});

/**
 * The xcframeworks that should carry a privacy manifest but aren't in this build (a rename
 * upstream, a dropped dependency). A release (package-ios --sign) treats each as a problem, so
 * it can't ship without a manifest; a local run only warns.
 * @param {Iterable<string>} built  The xcframework names in the build.
 */
export function missingPrivacyManifests(built) {
  const have = new Set(built);
  return Object.keys(PRIVACY_MANIFESTS).filter((name) => !have.has(name));
}

/**
 * The required-reason API categories and the reasons Apple accepts for each (TN: "Describing use
 * of required reason API").
 */
export const API_REASONS = /** @type {const} */ ({
  NSPrivacyAccessedAPICategoryFileTimestamp: ['DDA9.1', 'C617.1', '3B52.1', '0A2A.1'],
  NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1', '8FFB.1', '3D61.1'],
  NSPrivacyAccessedAPICategoryDiskSpace: ['85F4.1', 'E174.1', '7D9E.1', 'B728.1'],
  NSPrivacyAccessedAPICategoryActiveKeyboards: ['3EC4.1', '54BD.1'],
  NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1', '1C8F.1', 'C56D.1', 'AC6B.1'],
});

const PURPOSES = new Set(
  [
    'ThirdPartyAdvertising',
    'DeveloperAdvertising',
    'Analytics',
    'ProductPersonalization',
    'AppFunctionality',
    'Other',
  ].map((p) => `NSPrivacyCollectedDataTypePurpose${p}`),
);

/**
 * What is wrong with a privacy manifest: a missing or mistyped top-level key, an unknown API
 * category, a reason that category doesn't accept, or a malformed collected-data entry. Empty when
 * it is well formed.
 * @param {string} xml
 */
export function privacyManifestProblems(xml) {
  /** @type {string[]} */
  const problems = [];
  let dict;
  try {
    dict = rootDict(parsePlist(xml));
  } catch (err) {
    return [`not a plist dictionary: ${err instanceof Error ? err.message : String(err)}`];
  }
  if (typeof dict.get('NSPrivacyTracking') !== 'boolean') {
    problems.push('NSPrivacyTracking is not a boolean');
  }
  const domains = dict.get('NSPrivacyTrackingDomains');
  if (domains !== undefined && !Array.isArray(domains)) {
    problems.push('NSPrivacyTrackingDomains is not an array');
  }

  const apis = dict.get('NSPrivacyAccessedAPITypes');
  if (!Array.isArray(apis)) problems.push('NSPrivacyAccessedAPITypes is not an array');
  else {
    const seen = new Set();
    for (const entry of apis) {
      const api = entry instanceof Map ? entry : new Map();
      const type = api.get('NSPrivacyAccessedAPIType');
      const reasons = api.get('NSPrivacyAccessedAPITypeReasons');
      if (typeof type !== 'string' || !(type in API_REASONS)) {
        problems.push(`unknown API category ${String(type)}`);
        continue;
      }
      if (seen.has(type)) problems.push(`${type} is listed twice`);
      seen.add(type);
      /** @type {readonly string[]} */
      const allowed = API_REASONS[/** @type {keyof typeof API_REASONS} */ (type)];
      if (!Array.isArray(reasons) || reasons.length === 0) {
        problems.push(`${type} gives no reasons`);
        continue;
      }
      for (const r of reasons) {
        if (typeof r !== 'string' || !allowed.includes(r)) {
          problems.push(`${type} doesn't accept reason ${String(r)}`);
        }
      }
    }
  }

  const collected = dict.get('NSPrivacyCollectedDataTypes');
  if (!Array.isArray(collected)) problems.push('NSPrivacyCollectedDataTypes is not an array');
  else {
    for (const entry of collected) {
      const data = entry instanceof Map ? entry : new Map();
      const type = data.get('NSPrivacyCollectedDataType');
      if (typeof type !== 'string' || !/^NSPrivacyCollectedDataType[A-Z][A-Za-z]+$/.test(type)) {
        problems.push(`bad collected data type ${String(type)}`);
        continue;
      }
      for (const key of [
        'NSPrivacyCollectedDataTypeLinked',
        'NSPrivacyCollectedDataTypeTracking',
      ]) {
        if (typeof data.get(key) !== 'boolean') problems.push(`${type}: ${key} is not a boolean`);
      }
      const purposes = data.get('NSPrivacyCollectedDataTypePurposes');
      if (!Array.isArray(purposes) || purposes.length === 0) {
        problems.push(`${type}: no purposes`);
      } else {
        for (const p of purposes) {
          if (typeof p !== 'string' || !PURPOSES.has(p)) problems.push(`${type}: bad purpose ${p}`);
        }
      }
    }
  }
  return problems;
}

/**
 * Where a manifest goes in a packaged xcframework: the root of the framework in each kept slice,
 * relative to the xcframework folder. A static library has no bundle to hold one, so it throws.
 * @param {string} name  The xcframework's file name, for messages.
 * @param {readonly import('./platforms.mjs').Library[]} keep  The kept slices.
 */
export function privacyDestinations(name, keep) {
  return keep.map((lib) => {
    if (!lib.libraryPath.endsWith('.framework')) {
      throw new Error(
        `${name}/${lib.id}: ${lib.libraryPath} is not a framework; no privacy manifest`,
      );
    }
    return `${lib.id}/${lib.libraryPath}/${PRIVACY_FILE}`;
  });
}
