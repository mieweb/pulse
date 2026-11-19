import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
  frameworksFromSums,
  placeholderPackageSwift,
  renderPackageSwift,
} from './release-package-swift.mjs';

const hex = (c: string) => c.repeat(64);

// A release's SHA256SUMS as package-ios.mjs writes it: the xcframework zips, the all-in-one zip,
// the dSYMs and the attached files, sorted by name.
const SUMS = [
  `${hex('1')}  PulseKit-dSYMs.zip`,
  `${hex('2')}  PulseKit-main.jsbundle.map`,
  `${hex('3')}  PulseKit-xcframeworks.zip`,
  `${hex('4')}  PulseKit.xcframework.zip`,
  `${hex('5')}  React.xcframework.zip`,
  `${hex('6')}  THIRD_PARTY_NOTICES.md`,
  `${hex('7')}  hermesvm.xcframework.zip`,
  `${hex('8')}  rnwhisper.xcframework.zip`,
  '',
].join('\n');

const BASE = 'https://github.com/mieweb/pulse/releases/download/pulsekit-v1.2.3-rc.1';

describe('frameworksFromSums', () => {
  it('takes one binary target per xcframework zip, sorted, and nothing else', () => {
    expect(frameworksFromSums(SUMS)).toEqual([
      { name: 'PulseKit', checksum: hex('4') },
      { name: 'React', checksum: hex('5') },
      { name: 'hermesvm', checksum: hex('7') },
      { name: 'rnwhisper', checksum: hex('8') },
    ]);
  });

  it('refuses a release without PulseKit or without any xcframework', () => {
    expect(() => frameworksFromSums(`${hex('5')}  React.xcframework.zip\n`)).toThrow(/PulseKit/);
    expect(() => frameworksFromSums(`${hex('1')}  PulseKit-dSYMs.zip\n`)).toThrow(/no \*/);
  });
});

describe('renderPackageSwift', () => {
  const release = { version: '1.2.3-rc.1', baseUrl: BASE, frameworks: frameworksFromSums(SUMS) };
  const text = renderPackageSwift(release);

  it('declares one remote binary target per xcframework with its checksum', () => {
    const rows = text.split('\n').filter((l) => /^ {2}\("[A-Za-z]+", "[0-9a-f]{64}"\),$/.test(l));
    expect(rows).toEqual([
      `  ("PulseKit", "${hex('4')}"),`,
      `  ("React", "${hex('5')}"),`,
      `  ("hermesvm", "${hex('7')}"),`,
      `  ("rnwhisper", "${hex('8')}"),`,
    ]);
    expect(text).toContain(`let releaseBase = "${BASE}"`);
    expect(text).toContain('let releaseVersion = "1.2.3-rc.1"');
    expect(text).toContain(
      'name: $0.name, url: "\\(releaseBase)/\\($0.name).xcframework.zip", checksum: $0.checksum)',
    );
    // The dSYMs and the CocoaPods zip are assets, not targets.
    expect(text).not.toContain('dSYMs"');
    expect(text).not.toContain('PulseKit-xcframeworks');
  });

  it('declares iOS 15 and keeps the PULSEKIT_LOCAL branch', () => {
    expect(text).toContain('platforms: [.iOS(.v15)],');
    expect(text).toContain('ProcessInfo.processInfo.environment["PULSEKIT_LOCAL"]');
    expect(text).toContain('.binaryTarget(name: $0, path: "\\(local)/\\($0).xcframework")');
    expect(text).toContain('releaseFrameworks.map { $0.name } : names');
  });

  it('is the same file whatever order the frameworks come in', () => {
    const shuffled = { ...release, frameworks: [...release.frameworks].reverse() };
    expect(renderPackageSwift(shuffled)).toBe(text);
    expect(renderPackageSwift(release)).toBe(text);
  });

  it('refuses what would break the manifest', () => {
    const one = (name: string, checksum = hex('a')) => ({
      ...release,
      frameworks: [{ name, checksum }],
    });
    expect(() => renderPackageSwift(one('Pulse"Kit'))).toThrow(/bad framework name/);
    expect(() => renderPackageSwift(one('PulseKit', 'abc'))).toThrow(/bad checksum/);
    expect(() =>
      renderPackageSwift({
        ...release,
        frameworks: [...release.frameworks, release.frameworks[0]],
      }),
    ).toThrow(/twice/);
    expect(() => renderPackageSwift({ ...release, baseUrl: 'http://example.com/x' })).toThrow(
      /https/,
    );
    expect(() => renderPackageSwift({ ...release, baseUrl: `${BASE}"` })).toThrow(/https/);
    expect(() => renderPackageSwift({ ...release, version: 'v1' })).toThrow(/semver/);
    expect(() => renderPackageSwift({ ...release, frameworks: [] })).toThrow(/no frameworks/);
  });
});

describe('the committed Package.swift', () => {
  it('is the generator’s placeholder, so the template has one home', () => {
    const committed = fs.readFileSync(
      path.join(__dirname, '../../packages/capacitor-pulse/Package.swift'),
      'utf8',
    );
    expect(committed).toBe(placeholderPackageSwift());
  });
});
