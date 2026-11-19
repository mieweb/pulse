import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cli,
  lockstepProblems,
  marketingVersion,
  packageFiles,
  parseReleaseTag,
  publishProblems,
  readPulseKitVersions,
  readStampedVersions,
  stampVersion,
} from './release-version.mjs';

const repoRoot = path.resolve(__dirname, '../../..');

/** The files stamping touches, copied from the repo into a scratch checkout. */
const STAMPED = [
  'embed/packages/pulse-embed/package.json',
  'embed/packages/capacitor-pulse/package.json',
  'embed/packages/cordova-plugin-pulse/package.json',
  'embed/packages/cordova-plugin-pulse/plugin.xml',
  'embed/app.json',
];

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-release-'));
  for (const rel of STAMPED) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, rel), path.join(dir, rel));
  }
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

describe('parseReleaseTag', () => {
  it('reads a final release: latest dist-tag, not a prerelease', () => {
    expect(parseReleaseTag('pulsekit-v2.7.1')).toEqual({
      tag: 'pulsekit-v2.7.1',
      version: '2.7.1',
      rc: null,
      prerelease: false,
      distTag: 'latest',
    });
  });

  it('maps an RC tag to the rc dist-tag and a GitHub prerelease', () => {
    expect(parseReleaseTag('pulsekit-v2.8.0-rc.3')).toEqual({
      tag: 'pulsekit-v2.8.0-rc.3',
      version: '2.8.0-rc.3',
      rc: 3,
      prerelease: true,
      distTag: 'rc',
    });
  });

  it.each([
    'pulsekit-v2.8',
    'pulsekit-v2.8.0.1',
    'pulsekit-v02.8.0',
    'pulsekit-v2.8.0-rc',
    'pulsekit-v2.8.0-rc.0',
    'pulsekit-v2.8.0-rc.01',
    'pulsekit-v2.8.0-beta.1',
    'pulsekit-v2.8.0-rc.1 ',
    'pulsekit-2.8.0',
    'app-v2.8.0',
    'v2.8.0',
    '',
  ])('refuses the malformed tag %j', (tag) => {
    expect(() => parseReleaseTag(tag)).toThrow(/not a PulseKit release tag/);
  });
});

describe('stampVersion', () => {
  it('writes the tag version into every package, app.json and plugin.xml, and nothing else', () => {
    const before = Object.fromEntries(
      STAMPED.filter((f) => f.endsWith('.json')).map((f) => [f, readJson(f)]),
    );
    const xmlBefore = fs.readFileSync(path.join(dir, STAMPED[3]), 'utf8');

    const written = stampVersion(dir, '2.8.0-rc.3');

    expect(written.sort()).toEqual([...STAMPED].sort());
    expect(readStampedVersions(dir)).toEqual([
      { file: 'embed/packages/capacitor-pulse/package.json', version: '2.8.0-rc.3' },
      { file: 'embed/packages/cordova-plugin-pulse/package.json', version: '2.8.0-rc.3' },
      { file: 'embed/packages/pulse-embed/package.json', version: '2.8.0-rc.3' },
      { file: 'embed/app.json', version: '2.8.0-rc.3' },
      { file: 'embed/app.json expo.ios.version', version: '2.8.0', marketing: true },
      { file: 'embed/packages/cordova-plugin-pulse/plugin.xml', version: '2.8.0-rc.3' },
    ]);
    for (const rel of packageFiles(dir)) {
      expect(readJson(rel)).toEqual({ ...before[rel], version: '2.8.0-rc.3' });
    }
    // The marketing version (PulseKit's CFBundleShortVersionString, via expo-brownfield) is the
    // numeric core: App Store Connect refuses `2.8.0-rc.3` there (ITMS-90060).
    const app = before['embed/app.json'];
    expect(readJson('embed/app.json')).toEqual({
      expo: { ...app.expo, version: '2.8.0-rc.3', ios: { ...app.expo.ios, version: '2.8.0' } },
    });
    const xmlAfter = fs.readFileSync(path.join(dir, STAMPED[3]), 'utf8');
    expect(xmlAfter).toBe(
      xmlBefore.replace(
        'id="cordova-plugin-pulse" version="0.0.0-dev"',
        'id="cordova-plugin-pulse" version="2.8.0-rc.3"',
      ),
    );
  });

  it('writes a final release’s version as its own marketing version', () => {
    stampVersion(dir, '2.8.0');
    expect(readJson('embed/app.json').expo).toMatchObject({
      version: '2.8.0',
      ios: { version: '2.8.0' },
    });
  });

  it('finds every embed package in the repo', () => {
    expect(packageFiles(repoRoot)).toEqual([
      'embed/packages/capacitor-pulse/package.json',
      'embed/packages/cordova-plugin-pulse/package.json',
      'embed/packages/pulse-embed/package.json',
    ]);
  });

  it('refuses a version that is not semver', () => {
    expect(() => stampVersion(dir, 'pulsekit-v2.8.0')).toThrow(/semver/);
    expect(readJson('embed/packages/pulse-embed/package.json').version).toBe('0.0.0-dev');
  });
});

describe('marketingVersion', () => {
  it('is the numeric core of a release version', () => {
    expect(marketingVersion('2.8.0')).toBe('2.8.0');
    expect(marketingVersion('2.8.0-rc.3')).toBe('2.8.0');
    expect(() => marketingVersion('2.8')).toThrow(/semver/);
  });
});

describe('lockstep', () => {
  const plist = (version: string, short = version.split('-')[0]) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n` +
    `\t<key>CFBundleName</key>\n\t<string>PulseKit</string>\n` +
    `\t<key>CFBundleShortVersionString</key>\n\t<string>${short}</string>\n` +
    `\t<key>PulseKitVersion</key>\n\t<string>${version}</string>\n</dict>\n</plist>\n`;
  const writePlist = (slice: string, version: string, short?: string) => {
    const file = path.join(
      dir,
      'xc',
      'PulseKit.xcframework',
      slice,
      'PulseKit.framework',
      'Info.plist',
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, plist(version, short));
  };
  const infoPlist = (slice: string) =>
    path.join('PulseKit.xcframework', slice, 'PulseKit.framework', 'Info.plist');

  it('passes when the tag, every package and both PulseKit slices agree', () => {
    stampVersion(dir, '2.8.0');
    writePlist('ios-arm64', '2.8.0');
    writePlist('ios-arm64_x86_64-simulator', '2.8.0');
    const pulseKit = readPulseKitVersions(path.join(dir, 'xc'));
    expect(pulseKit).toHaveLength(4);
    expect(lockstepProblems('2.8.0', readStampedVersions(dir), pulseKit)).toEqual([]);
  });

  it('on an RC, wants the full version in PulseKitVersion and the core in the marketing version', () => {
    stampVersion(dir, '2.8.0-rc.3');
    writePlist('ios-arm64', '2.8.0-rc.3');
    writePlist('ios-arm64_x86_64-simulator', '2.8.0-rc.3');
    expect(readPulseKitVersions(path.join(dir, 'xc'))).toEqual([
      { file: infoPlist('ios-arm64'), version: '2.8.0-rc.3' },
      {
        file: `${infoPlist('ios-arm64')} CFBundleShortVersionString`,
        version: '2.8.0',
        marketing: true,
      },
      { file: infoPlist('ios-arm64_x86_64-simulator'), version: '2.8.0-rc.3' },
      {
        file: `${infoPlist('ios-arm64_x86_64-simulator')} CFBundleShortVersionString`,
        version: '2.8.0',
        marketing: true,
      },
    ]);
    expect(
      lockstepProblems(
        '2.8.0-rc.3',
        readStampedVersions(dir),
        readPulseKitVersions(path.join(dir, 'xc')),
      ),
    ).toEqual([]);
  });

  it('refuses an RC PulseKit whose CFBundleShortVersionString carries the -rc suffix', () => {
    stampVersion(dir, '2.8.0-rc.3');
    writePlist('ios-arm64', '2.8.0-rc.3', '2.8.0-rc.3');
    const app = readJson('embed/app.json');
    app.expo.ios.version = '2.8.0-rc.3';
    fs.writeFileSync(path.join(dir, 'embed/app.json'), JSON.stringify(app));
    expect(
      lockstepProblems(
        '2.8.0-rc.3',
        readStampedVersions(dir),
        readPulseKitVersions(path.join(dir, 'xc')),
      ),
    ).toEqual([
      'embed/app.json expo.ios.version is 2.8.0-rc.3, not 2.8.0',
      `${infoPlist('ios-arm64')} CFBundleShortVersionString is 2.8.0-rc.3, not 2.8.0`,
    ]);
  });

  it('names every place that differs from the tag', () => {
    stampVersion(dir, '2.8.0');
    writePlist('ios-arm64', '2.7.9');
    const pkg = 'embed/packages/capacitor-pulse/package.json';
    fs.writeFileSync(path.join(dir, pkg), JSON.stringify({ ...readJson(pkg), version: '2.8.1' }));
    const problems = lockstepProblems(
      '2.8.0',
      readStampedVersions(dir),
      readPulseKitVersions(path.join(dir, 'xc')),
    );
    expect(problems).toEqual([
      `${pkg} is 2.8.1, not 2.8.0`,
      `${infoPlist('ios-arm64')} is 2.7.9, not 2.8.0`,
      `${infoPlist('ios-arm64')} CFBundleShortVersionString is 2.7.9, not 2.8.0`,
    ]);
  });

  it('fails when there is no PulseKit Info.plist to check', () => {
    expect(lockstepProblems('2.8.0', [], [])).toEqual([
      'no PulseKit.framework Info.plist to check',
    ]);
    expect(() => readPulseKitVersions(path.join(dir, 'nothing'))).toThrow(/no PulseKit/);
  });
});

describe('publishProblems', () => {
  it('passes on the real checkout: every package can publish from mieweb/pulse', () => {
    expect(publishProblems(repoRoot, 'mieweb/pulse')).toEqual([]);
  });

  it('needs every package’s repository.url to be the repo the workflow runs in', () => {
    const pkg = 'embed/packages/pulse-embed/package.json';
    const { repository, ...rest } = readJson(pkg);
    expect(repository).toBeDefined();
    fs.writeFileSync(path.join(dir, pkg), JSON.stringify(rest));
    expect(publishProblems(dir, 'mieweb/pulse')).toEqual([
      `${pkg}: repository.url is (none); provenance needs https://github.com/mieweb/pulse`,
    ]);

    fs.writeFileSync(
      path.join(dir, pkg),
      JSON.stringify({
        ...rest,
        repository: { type: 'git', url: 'git+https://github.com/mieweb/pulse.git' },
      }),
    );
    expect(publishProblems(dir, 'mieweb/pulse')).toEqual([]);
    expect(publishProblems(dir, 'someone/fork')).toHaveLength(3);
  });

  it('refuses a private package', () => {
    const pkg = 'embed/packages/capacitor-pulse/package.json';
    fs.writeFileSync(path.join(dir, pkg), JSON.stringify({ ...readJson(pkg), private: true }));
    expect(publishProblems(dir, 'mieweb/pulse')).toContain(`${pkg}: "private": true`);
  });
});

describe('cli', () => {
  it('prints the tag’s outputs in $GITHUB_OUTPUT form', () => {
    const lines: string[] = [];
    cli(['tag', 'pulsekit-v2.8.0-rc.3'], { repoRoot: dir, out: (l) => lines.push(l) });
    expect(lines).toEqual(['version=2.8.0-rc.3', 'dist_tag=rc', 'prerelease=true']);
  });

  it('stamps, then fails lockstep on a PulseKit built at another version', () => {
    const lines: string[] = [];
    cli(['stamp', '2.8.0'], { repoRoot: dir, out: (l) => lines.push(l) });
    expect(lines).toHaveLength(5);
    const file = path.join(
      dir,
      'xc',
      'PulseKit.xcframework',
      'ios-arm64',
      'PulseKit.framework',
      'Info.plist',
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      '<plist version="1.0"><dict><key>PulseKitVersion</key><string>2.7.0</string></dict></plist>',
    );
    expect(() => cli(['lockstep', '2.8.0', 'xc'], { repoRoot: dir, out: () => {} })).toThrow(
      /Not in lockstep with 2\.8\.0:\n {2}PulseKit\.xcframework/,
    );
    expect(() => cli(['nope'], { repoRoot: dir })).toThrow(/unknown command/);
  });
});
