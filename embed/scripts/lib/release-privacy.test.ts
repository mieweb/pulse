import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import type { Library } from './platforms.mjs';
import {
  PRIVACY_MANIFESTS,
  privacyDestinations,
  privacyManifestProblems,
} from './release-privacy.mjs';

const repoRoot = path.resolve(__dirname, '../../..');

const manifest = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
const api = (type: string, ...reasons: string[]) =>
  `<dict><key>NSPrivacyAccessedAPIType</key><string>${type}</string>` +
  `<key>NSPrivacyAccessedAPITypeReasons</key><array>${reasons
    .map((r) => `<string>${r}</string>`)
    .join('')}</array></dict>`;
const valid = (apis: string, collected = '') =>
  manifest(
    `<key>NSPrivacyTracking</key><false/>` +
      `<key>NSPrivacyAccessedAPITypes</key><array>${apis}</array>` +
      `<key>NSPrivacyCollectedDataTypes</key><array>${collected}</array>`,
  );

describe('the shipped privacy manifests', () => {
  it.each(Object.entries(PRIVACY_MANIFESTS))('%s: %s is well formed', (_name, rel) => {
    const xml = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    expect(privacyManifestProblems(xml)).toEqual([]);
  });

  it('covers PulseKit, hermes, SDWebImage and rnwhisper (K2)', () => {
    expect(Object.keys(PRIVACY_MANIFESTS).sort()).toEqual([
      'PulseKit.xcframework',
      'SDWebImage.xcframework',
      'hermesvm.xcframework',
      'rnwhisper.xcframework',
    ]);
  });
});

describe('privacyManifestProblems', () => {
  it('accepts declared categories with their own reasons', () => {
    const xml = valid(
      api('NSPrivacyAccessedAPICategoryFileTimestamp', 'C617.1') +
        api('NSPrivacyAccessedAPICategoryDiskSpace', 'E174.1'),
    );
    expect(privacyManifestProblems(xml)).toEqual([]);
  });

  it('rejects a reason another category owns, an unknown category and a repeat', () => {
    const xml = valid(
      api('NSPrivacyAccessedAPICategoryFileTimestamp', 'CA92.1') +
        api('NSPrivacyAccessedAPICategoryMagic', 'C617.1') +
        api('NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1') +
        api('NSPrivacyAccessedAPICategoryUserDefaults', 'CA92.1') +
        api('NSPrivacyAccessedAPICategoryDiskSpace'),
    );
    expect(privacyManifestProblems(xml)).toEqual([
      "NSPrivacyAccessedAPICategoryFileTimestamp doesn't accept reason CA92.1",
      'unknown API category NSPrivacyAccessedAPICategoryMagic',
      'NSPrivacyAccessedAPICategoryUserDefaults is listed twice',
      'NSPrivacyAccessedAPICategoryDiskSpace gives no reasons',
    ]);
  });

  it('needs the top-level keys with the right types', () => {
    expect(
      privacyManifestProblems(manifest('<key>NSPrivacyTracking</key><string>no</string>')),
    ).toEqual([
      'NSPrivacyTracking is not a boolean',
      'NSPrivacyAccessedAPITypes is not an array',
      'NSPrivacyCollectedDataTypes is not an array',
    ]);
    expect(privacyManifestProblems('not a plist')[0]).toMatch(/^not a plist dictionary/);
  });

  it('checks each collected data type’s flags and purposes', () => {
    const entry = (linked: string, purposes: string) =>
      `<dict><key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypePhotosorVideos</string>` +
      `<key>NSPrivacyCollectedDataTypeLinked</key>${linked}` +
      `<key>NSPrivacyCollectedDataTypeTracking</key><false/>` +
      `<key>NSPrivacyCollectedDataTypePurposes</key><array>${purposes}</array></dict>`;
    const ok = '<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>';
    expect(privacyManifestProblems(valid('', entry('<true/>', ok)))).toEqual([]);
    expect(privacyManifestProblems(valid('', entry('<string>yes</string>', '')))).toEqual([
      'NSPrivacyCollectedDataTypePhotosorVideos: NSPrivacyCollectedDataTypeLinked is not a boolean',
      'NSPrivacyCollectedDataTypePhotosorVideos: no purposes',
    ]);
  });
});

describe('privacyDestinations', () => {
  const lib = (id: string, libraryPath: string): Library => ({
    id,
    libraryPath,
    binaryPath: libraryPath,
    debugSymbolsPath: null,
    platform: 'ios',
    variant: id.endsWith('simulator') ? 'simulator' : null,
    archs: [],
    kind: id.endsWith('simulator') ? 'simulator' : 'device',
  });

  it('puts the manifest at the root of the framework in every kept slice', () => {
    expect(
      privacyDestinations('hermesvm.xcframework', [
        lib('ios-arm64', 'hermesvm.framework'),
        lib('ios-arm64_x86_64-simulator', 'hermesvm.framework'),
      ]),
    ).toEqual([
      'ios-arm64/hermesvm.framework/PrivacyInfo.xcprivacy',
      'ios-arm64_x86_64-simulator/hermesvm.framework/PrivacyInfo.xcprivacy',
    ]);
  });

  it('refuses a static library, which has no bundle to hold one', () => {
    expect(() => privacyDestinations('libx.xcframework', [lib('ios-arm64', 'libx.a')])).toThrow(
      /not a framework/,
    );
  });
});
