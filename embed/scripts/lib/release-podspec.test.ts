import { afterAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

describe('the PULSEKIT_LOCAL zip', () => {
  const text = placeholderPodspec();
  // The podspec's source picker on its own, without CocoaPods.
  const picker = text.slice(text.indexOf('def pulsekit_source'), text.indexOf('\nend\n') + 5);

  it('is named by a fingerprint of the files inside the frameworks, not their folders’ mtimes', () => {
    expect(picker).not.toContain('File.mtime');
    expect(picker).toContain('Digest::SHA256.file(full)');
    expect(picker).toContain('zip = "#{prefix}-#{fingerprint.hexdigest[0, 16]}.zip"');
  });

  // Runs the picker with Ruby and zip, as `pod install` would (both are on macOS and CI's Ubuntu).
  const tools = ['ruby', 'zip'].every((t) => spawnSync(t, ['-v']).status === 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsekit-local-test-'));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  (tools ? it : it.skip)('is made again when a nested file is overwritten in place', () => {
    const frameworks = path.join(root, 'xcframeworks');
    const binary = path.join(frameworks, 'PulseKit.xcframework', 'ios-arm64', 'PulseKit');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(path.join(frameworks, 'PulseKit.xcframework', 'Info.plist'), '<plist/>');
    fs.writeFileSync(binary, 'build-1');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(tmp);
    const script = path.join(root, 'picker.rb');
    fs.writeFileSync(
      script,
      `require 'digest'\nrequire 'tmpdir'\n${picker}\nputs pulsekit_source[:http]\n`,
    );
    const pick = () => {
      const run = spawnSync('ruby', [script], {
        env: { ...process.env, PULSEKIT_LOCAL: frameworks, TMPDIR: tmp },
        encoding: 'utf8',
      });
      expect(run.stderr).toBe('');
      return run.stdout.trim().replace(/^file:\/\//, '');
    };

    const first = pick();
    expect(fs.existsSync(first)).toBe(true);
    expect(pick()).toBe(first); // nothing changed: the same zip

    // An in-place rebuild: same size, and the folders' (and even the file's) mtimes kept.
    const folderTimes = fs.statSync(path.join(frameworks, 'PulseKit.xcframework'));
    const fileTimes = fs.statSync(binary);
    fs.writeFileSync(binary, 'build-2');
    fs.utimesSync(binary, fileTimes.atime, fileTimes.mtime);
    fs.utimesSync(
      path.join(frameworks, 'PulseKit.xcframework'),
      folderTimes.atime,
      folderTimes.mtime,
    );

    const second = pick();
    expect(second).not.toBe(first);
    expect(fs.existsSync(first)).toBe(false); // the stale zip is gone
    const listed = spawnSync('unzip', ['-p', second, 'PulseKit.xcframework/ios-arm64/PulseKit'], {
      encoding: 'utf8',
    });
    expect(listed.stdout).toBe('build-2');
  });
});
