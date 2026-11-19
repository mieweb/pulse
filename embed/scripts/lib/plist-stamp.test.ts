import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { CONTRACT } from '@mieweb/pulse-embed';
import { APP_SCHEMA_VERSION, PROJECT_VERSION } from '@/db/project';

// project.ts loads drizzle's expo-sqlite driver; the Node stand-in keeps it importable here.
jest.mock(
  'expo-sqlite',
  () =>
    jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
      '@/test-support/expo-sqlite-node',
    ).mockModule,
);

import { buildPlist, isBinaryPlist, parsePlist, rootDict } from './plist.mjs';
import { readSourceStamps, stampPlist, STAMP_KEYS, validateStamps } from './plist-stamp.mjs';

const repoRoot = path.resolve(__dirname, '../../..');
const fixture = path.join(__dirname, '__fixtures__', 'fake-build');
const frameworkPlist = fs.readFileSync(
  path.join(fixture, 'PulseKit.xcframework', 'ios-arm64', 'PulseKit.framework', 'Info.plist'),
  'utf8',
);

const stamps = {
  version: '1.2.3-rc.1',
  build: '42',
  gitSha: '6c4019271fabbb21bdb0d9f426dfe46e6402d45a',
  contractMinor: 0,
  formatVersion: 2,
  dbSchema: 1794267575371,
};

describe('plist', () => {
  it('reads every value type and writes it back unchanged', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<plist version="1.0">
<dict>
  <key>s</key><string>a &amp; b &lt;c&gt; &#x263A;</string>
  <key>empty</key><string/>
  <key>n</key><integer>-7</integer>
  <key>big</key><integer>9007199254740993</integer>
  <key>r</key><real>1.5</real>
  <key>t</key><true/>
  <key>f</key><false/>
  <key>d</key><date>2026-11-18T00:00:00Z</date>
  <key>b</key><data>
    AAEC
  </data>
  <key>a</key><array><string>x</string><array/></array>
  <key>m</key><dict/>
</dict>
</plist>`;
    const dict = rootDict(parsePlist(xml));
    expect(Object.fromEntries(dict)).toEqual({
      s: 'a & b <c> ☺',
      empty: '',
      n: -7,
      big: 9007199254740993n,
      r: { real: '1.5' },
      t: true,
      f: false,
      d: { date: '2026-11-18T00:00:00Z' },
      b: { data: 'AAEC' },
      a: ['x', []],
      m: new Map(),
    });
    expect(parsePlist(buildPlist(dict))).toEqual(dict);
    expect(buildPlist(dict)).toContain('<string>a &amp; b &lt;c&gt; ☺</string>');
  });

  it('writes the layout plutil does, so an untouched file round-trips byte for byte', () => {
    expect(buildPlist(parsePlist(frameworkPlist))).toBe(frameworkPlist);
  });

  it('refuses binary plists and malformed documents', () => {
    expect(isBinaryPlist(Buffer.from('bplist00…'))).toBe(true);
    expect(() => parsePlist('bplist00')).toThrow('binary plist');
    expect(() => parsePlist('<plist><dict><key>k</key></dict></plist>')).toThrow('has no value');
    expect(() => parsePlist('<plist><dict><string>x</string></dict></plist>')).toThrow(
      'expected <key>',
    );
    expect(() => parsePlist('<dict/>')).toThrow('missing <plist>');
  });
});

describe('stampPlist', () => {
  it('adds the six PulseKit keys with the types PulseKitInfo.swift reads', () => {
    const out = stampPlist(frameworkPlist, stamps);
    const dict = rootDict(parsePlist(out));
    expect(dict.get('PulseKitVersion')).toBe('1.2.3-rc.1');
    expect(dict.get('PulseKitBuild')).toBe('42');
    expect(dict.get('PulseKitGitSha')).toBe(stamps.gitSha);
    expect(dict.get('PulseKitContractMinor')).toBe(0);
    expect(dict.get('PulseKitFormatVersion')).toBe(2);
    expect(dict.get('PulseKitDbSchema')).toBe(1794267575371);
    expect(out).toContain('<key>PulseKitDbSchema</key>\n\t<integer>1794267575371</integer>');
    expect(out).toContain('<key>PulseKitBuild</key>\n\t<string>42</string>');
    // The framework's own keys stay, first and in order.
    expect([...dict.keys()]).toEqual([
      'CFBundleExecutable',
      'CFBundleIdentifier',
      'CFBundlePackageType',
      'CFBundleShortVersionString',
      'MinimumOSVersion',
      ...STAMP_KEYS.map(([key]) => key),
    ]);
  });

  it('replaces earlier stamps in place instead of adding a second copy', () => {
    const once = stampPlist(frameworkPlist, stamps);
    const twice = stampPlist(once, { ...stamps, build: '43' });
    expect(twice.match(/<key>PulseKitBuild<\/key>/g)).toHaveLength(1);
    expect(rootDict(parsePlist(twice)).get('PulseKitBuild')).toBe('43');
  });

  it('refuses bad stamps', () => {
    expect(() => validateStamps({ ...stamps, version: 'v1' })).toThrow('not semver');
    expect(() => validateStamps({ ...stamps, build: '4a' })).toThrow('build "4a"');
    expect(() => validateStamps({ ...stamps, gitSha: 'HEAD' })).toThrow('not a hex commit id');
    expect(() => validateStamps({ ...stamps, dbSchema: -1 })).toThrow('dbSchema -1');
    expect(() => validateStamps({ ...stamps, contractMinor: 0.5 })).toThrow('contractMinor 0.5');
  });
});

describe('readSourceStamps', () => {
  it('reads the same numbers the code uses', () => {
    const fromSource = readSourceStamps(repoRoot);
    expect(fromSource.contractMinor).toBe(CONTRACT.minor);
    expect(fromSource.formatVersion).toBe(PROJECT_VERSION);
    expect(fromSource.dbSchema).toBe(APP_SCHEMA_VERSION);
    const readVersion = (rel: string) =>
      (JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8')) as { version: string })
        .version;
    // PulseKitVersion is the app version it was built from (AD18), not pulse-embed's own.
    expect(fromSource.version).toBe(readVersion('package.json'));
    expect(fromSource.embedPackageVersion).toBe(
      readVersion('embed/packages/pulse-embed/package.json'),
    );
  });
});
