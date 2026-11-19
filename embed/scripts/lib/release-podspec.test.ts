import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { placeholderPodspec, renderPodspec, xcframeworksZipSha256 } from './release-podspec.mjs';

const hex = (c: string) => c.repeat(64);

const SUMS = [
  `${hex('1')}  PulseKit-dSYMs.zip`,
  `${hex('3')}  PulseKit-xcframeworks.zip`,
  `${hex('4')}  PulseKit.xcframework.zip`,
  '',
].join('\n');

const BASE = 'https://github.com/mieweb/pulse/releases/download/pulsekit-v1.2.3-rc.1';

describe('xcframeworksZipSha256', () => {
  it('takes the all-in-one zip’s checksum, not PulseKit’s own', () => {
    expect(xcframeworksZipSha256(SUMS)).toBe(hex('3'));
  });

  it('refuses a release without the all-in-one zip', () => {
    expect(() => xcframeworksZipSha256(`${hex('4')}  PulseKit.xcframework.zip\n`)).toThrow(
      /PulseKit-xcframeworks\.zip/,
    );
  });
});

describe('renderPodspec', () => {
  const text = renderPodspec({ version: '1.2.3-rc.1', baseUrl: BASE, sha256: hex('3') });

  it('downloads the release zip over :http and checks it with :sha256', () => {
    expect(text).toContain(`PULSEKIT_RELEASE_URL = '${BASE}/PulseKit-xcframeworks.zip'`);
    expect(text).toContain(`PULSEKIT_RELEASE_SHA256 = '${hex('3')}'`);
    expect(text).toContain(
      'return { :http => PULSEKIT_RELEASE_URL, :sha256 => PULSEKIT_RELEASE_SHA256 } if local.empty?',
    );
    expect(text).toContain("s.version = '1.2.3-rc.1'");
    expect(text).toContain("s.vendored_frameworks = '*.xcframework'");
    expect(text).toContain("s.platform = :ios, '15.0'");
  });

  it('keeps the PULSEKIT_LOCAL development source', () => {
    expect(text).toContain("local = ENV.fetch('PULSEKIT_LOCAL', '')");
  });

  it('refuses what would break the podspec', () => {
    const ok = { version: '1.2.3', baseUrl: BASE, sha256: hex('3') };
    expect(() => renderPodspec({ ...ok, sha256: 'abc' })).toThrow(/SHA-256/);
    expect(() => renderPodspec({ ...ok, baseUrl: `${BASE}'` })).toThrow(/https/);
    expect(() => renderPodspec({ ...ok, version: '1.2' })).toThrow(/semver/);
  });
});

describe('the committed PulseKit.podspec', () => {
  it('is the generator’s placeholder, so the template has one home', () => {
    const committed = fs.readFileSync(
      path.join(__dirname, '../../packages/cordova-plugin-pulse/PulseKit.podspec'),
      'utf8',
    );
    expect(committed).toBe(placeholderPodspec());
  });
});
