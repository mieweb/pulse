import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
  frameworkName,
  listLibraries,
  planSlices,
  prunedManifest,
  sharedEntries,
} from './platforms.mjs';
import { buildPlist, parsePlist, rootDict } from './plist.mjs';

const fixture = path.join(__dirname, '__fixtures__', 'fake-build');
const manifestOf = (name: string) =>
  parsePlist(fs.readFileSync(path.join(fixture, name, 'Info.plist'), 'utf8'));

describe('planSlices', () => {
  it('keeps hermesvm’s iOS device and Simulator slices and prunes Catalyst and visionOS', () => {
    const { keep, drop } = planSlices('hermesvm.xcframework', manifestOf('hermesvm.xcframework'));
    expect(keep.map((l) => [l.id, l.kind])).toEqual([
      ['ios-arm64', 'device'],
      ['ios-arm64_x86_64-simulator', 'simulator'],
    ]);
    expect(drop.map((l) => l.id)).toEqual(['ios-arm64_x86_64-maccatalyst', 'xros-arm64']);
    expect(keep[1].archs).toEqual(['arm64', 'x86_64']);
  });

  it('fails when a host would be missing the device or Simulator slice', () => {
    const manifest = manifestOf('hermesvm.xcframework');
    const root = rootDict(manifest);
    const libs = root.get('AvailableLibraries') as Map<string, unknown>[];
    const noSim = new Map(root);
    noSim.set(
      'AvailableLibraries',
      libs.filter((l) => l.get('LibraryIdentifier') !== 'ios-arm64_x86_64-simulator') as never,
    );
    expect(() => planSlices('hermesvm.xcframework', noSim)).toThrow(
      'hermesvm.xcframework: expected one iOS simulator slice, found 0',
    );
  });
});

describe('listLibraries', () => {
  it('derives X.framework/X when BinaryPath is absent, as in whisper.rn’s manifest', () => {
    const react = listLibraries(manifestOf('React.xcframework'));
    expect(react[0]).toMatchObject({
      id: 'ios-arm64',
      libraryPath: 'React.framework',
      binaryPath: 'React.framework/React',
      debugSymbolsPath: null,
    });
    const catalyst = listLibraries(manifestOf('hermesvm.xcframework')).find(
      (l) => l.variant === 'maccatalyst',
    );
    expect(catalyst?.binaryPath).toBe('hermesvm.framework/Versions/1/hermesvm');
    expect(frameworkName(react[0])).toBe('React');
    expect(frameworkName({ ...react[0], libraryPath: 'libfoo.a' })).toBeNull();
  });
});

describe('prunedManifest', () => {
  it('lists only the kept slices and drops DebugSymbolsPath, keeping the other keys', () => {
    const manifest = manifestOf('PulseKit.xcframework');
    const { keep } = planSlices('PulseKit.xcframework', manifest);
    expect(keep.every((l) => l.debugSymbolsPath === 'dSYMs')).toBe(true);
    const xml = buildPlist(prunedManifest(manifest, keep));
    expect(xml).not.toContain('DebugSymbolsPath');
    expect(xml).toContain('<string>XFWK</string>');

    const hermes = manifestOf('hermesvm.xcframework');
    const pruned = rootDict(prunedManifest(hermes, planSlices('hermesvm', hermes).keep));
    const ids = (pruned.get('AvailableLibraries') as Map<string, unknown>[]).map((l) =>
      l.get('LibraryIdentifier'),
    );
    expect(ids).toEqual(['ios-arm64', 'ios-arm64_x86_64-simulator']);
    // The input manifest is left alone.
    expect((rootDict(hermes).get('AvailableLibraries') as unknown[]).length).toBe(4);
  });
});

describe('sharedEntries', () => {
  it('copies shared Headers but not slices, Info.plist or the xcframework signature', () => {
    const dir = path.join(fixture, 'React.xcframework');
    const all = listLibraries(manifestOf('React.xcframework'));
    expect(sharedEntries(fs.readdirSync(dir), all)).toEqual(['Headers']);
  });
});
