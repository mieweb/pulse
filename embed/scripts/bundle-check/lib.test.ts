import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import {
  bundleProblems,
  classificationProblems,
  facadeProblems,
  forbiddenPackages,
  isNativePackage,
  nativeSymbolProblems,
  packagesOf,
  parseDeps,
  repoPath,
  stripSwiftComments,
} from './lib.mjs';

const repoRoot = path.resolve(__dirname, '../../..');
const readRepo = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const readJson = (rel: string) => JSON.parse(readRepo(rel));
const fixture = (name: string) => readJson(`embed/scripts/bundle-check/__fixtures__/${name}`);

/** The shipped embed/deps.json, parsed. */
function shippedDeps() {
  const { deps, problems } = parseDeps(readJson('embed/deps.json'));
  expect(problems).toEqual([]);
  if (!deps) throw new Error('unreachable');
  return deps;
}

/** The rules check:embed scans with: the shipped exclusions and the standalone-only paths. */
const shippedRules = () => ({ projectDir: 'embed', packages: forbiddenPackages(shippedDeps()) });

describe('repoPath', () => {
  it('reads Metro sources relative to the bundled project (embed/)', () => {
    expect(repoPath('/src/shell/flow-stack.tsx', 'embed')).toBe('embed/src/shell/flow-stack.tsx');
    expect(repoPath('/../src/db/client.ts', 'embed')).toBe('src/db/client.ts');
    expect(repoPath('/../node_modules/expo/index.js', 'embed')).toBe('node_modules/expo/index.js');
  });

  it('keeps a path that leaves the repo (node_modules linked from another checkout)', () => {
    expect(repoPath('/../../../pulse/node_modules/expo/index.js', 'embed')).toBe(
      '../../pulse/node_modules/expo/index.js',
    );
  });

  it('skips entries that are not files', () => {
    expect(repoPath('__prelude__', 'embed')).toBeNull();
    expect(repoPath('\0polyfill:external-require', 'embed')).toBeNull();
  });
});

describe('packagesOf', () => {
  it('names every package along the path, scoped ones included', () => {
    expect(
      packagesOf('node_modules/expo-router/node_modules/@react-navigation/native/x.js'),
    ).toEqual(['expo-router', '@react-navigation/native']);
    expect(
      packagesOf('../../pulse/node_modules/@react-native-async-storage/async-storage/a.js'),
    ).toEqual(['@react-native-async-storage/async-storage']);
    expect(packagesOf('src/app/index.tsx')).toEqual([]);
  });
});

describe('bundleProblems (rule 5)', () => {
  it('passes a clean bundle: stubs, shared features and allowed packages', () => {
    expect(bundleProblems(fixture('clean.map.json'), shippedRules())).toEqual([]);
  });

  it('fails a bundle that contains expo-router, naming its modules', () => {
    const problems = bundleProblems(fixture('router.map.json'), shippedRules());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^expo-router: 3 modules in the bundle \(node_modules\/expo-router\//,
    );
    expect(problems[0]).toContain(
      'node_modules/expo-router/node_modules/@react-navigation/native/',
    );
  });

  it('fails on each package the shipped deps.json excludes and on the screen recorder', () => {
    const packages = [
      '@react-native-async-storage/async-storage',
      'expo-clipboard',
      'expo-linking',
      'expo-notifications',
      'expo-status-bar',
      'react-native-background-actions',
      'react-native-nitro-screen-recorder',
    ];
    for (const name of packages) {
      const map = { sources: [`/../node_modules/${name}/index.js`] };
      expect(bundleProblems(map, shippedRules())).toEqual([
        expect.stringMatching(new RegExp(`^${name}: 1 module in the bundle`)),
      ]);
    }
  });

  it('fails on the standalone shell and standalone-only features', () => {
    const map = {
      sources: [
        '/../src/app/_layout.tsx',
        '/../src/features/onboarding/onboarding-screen.tsx',
        '/../src/features/upload/pairing-sheet.tsx',
        '/../src/features/upload/pairing/listener.ts',
        '/../src/features/draft-transfer/pack.ts',
      ],
    };
    const problems = bundleProblems(map, shippedRules());
    expect(problems.map((p) => p.split(':')[0])).toEqual([
      'src/app/',
      'src/features/onboarding/',
      'src/features/upload/pairing-sheet.tsx',
      'src/features/upload/pairing/',
      'src/features/draft-transfer/',
    ]);
  });

  it('matches paths only outside node_modules, and file rules exactly', () => {
    const map = {
      sources: [
        '/../node_modules/some-lib/src/app/index.js',
        '/src/app/thing.ts', // embed/src/app, not the standalone shell
        '/../src/features/upload/pairing-sheet-copy.ts',
      ],
    };
    expect(bundleProblems(map, shippedRules())).toEqual([]);
  });

  it('fails a map with no sources rather than passing it', () => {
    expect(bundleProblems({ sources: [] }, shippedRules())).toHaveLength(1);
    expect(bundleProblems({}, shippedRules())).toHaveLength(1);
  });
});

describe('classificationProblems (rule 7)', () => {
  const native = new Set(['expo-sqlite', 'expo-router', 'expo-foo', 'expo-brownfield']);
  const isNative = (name: string) => native.has(name);
  const root = {
    dependencies: { 'expo-sqlite': '1', 'expo-router': '1', fflate: '1' },
    devDependencies: { 'expo-brownfield': '1', jest: '1' },
  };
  const embed = { dependencies: { 'expo-sqlite': '*', 'expo-brownfield': '*', fflate: '*' } };
  const deps = {
    included: { 'expo-sqlite': 'pulse.db', 'expo-brownfield': 'builds PulseKit' },
    excluded: { 'expo-router': 'no router' },
  };

  it('passes when every native dependency is classified and embed/package.json agrees', () => {
    expect(
      classificationProblems({ rootPackage: root, embedPackage: embed, deps, isNative }),
    ).toEqual([]);
  });

  it('fails on an unclassified native dependency, and not on a JS-only one', () => {
    const rootPackage = {
      ...root,
      dependencies: { ...root.dependencies, 'expo-foo': '1', 'js-only': '1' },
    };
    expect(classificationProblems({ rootPackage, embedPackage: embed, deps, isNative })).toEqual([
      expect.stringMatching(/^expo-foo is a native dependency .* doesn't classify it/),
    ]);
  });

  it('fails when the classification and embed/package.json disagree', () => {
    const embedPackage = {
      dependencies: { 'expo-router': '*', fflate: '*', 'not-installed': '*' },
    };
    expect(classificationProblems({ rootPackage: root, embedPackage, deps, isNative })).toEqual([
      expect.stringMatching(/^expo-sqlite is included .* embed\/package\.json doesn't list it/),
      expect.stringMatching(/^expo-brownfield is included .* embed\/package\.json doesn't list it/),
      'expo-router is excluded in embed/deps.json but embed/package.json links it',
      expect.stringMatching(/^embed\/package\.json lists not-installed, which the root/),
    ]);
  });

  it('fails on a stale entry and on a package both included and excluded', () => {
    const stale = {
      included: { ...deps.included, 'expo-network': 'gone' },
      excluded: { ...deps.excluded, 'expo-sqlite': 'twice' },
    };
    const problems = classificationProblems({
      rootPackage: root,
      embedPackage: embed,
      deps: stale,
      isNative,
    });
    expect(problems).toContain('expo-sqlite is both included and excluded in embed/deps.json');
    expect(problems).toContain(
      "embed/deps.json classifies expo-network, which the root package.json doesn't list",
    );
  });
});

describe('parseDeps', () => {
  it('needs both sections and a reason for every entry', () => {
    expect(parseDeps({ included: { a: 'why' } }).problems).toEqual([
      'embed/deps.json has no "excluded" object',
    ]);
    expect(parseDeps({ included: { a: ' ' }, excluded: {} }).problems).toEqual([
      'embed/deps.json: included "a" needs a one-line reason',
    ]);
    expect(parseDeps({ included: {}, excluded: {}, extra: {} }).problems).toEqual([
      'embed/deps.json: unknown key "extra"',
    ]);
    expect(parseDeps([]).deps).toBeNull();
  });
});

describe('isNativePackage', () => {
  it('reads native markers at the top of a package folder', () => {
    expect(isNativePackage(['package.json', 'expo-module.config.json', 'build'])).toBe(true);
    expect(isNativePackage(['package.json', 'RNScreens.podspec', 'src'])).toBe(true);
    expect(isNativePackage(['package.json', 'apple', 'src'])).toBe(true);
    expect(isNativePackage(['package.json', 'app.plugin.js', 'build'])).toBe(false);
    expect(isNativePackage(['package.json', 'lib', 'README.md'])).toBe(false);
  });
});

describe('the shipped embed/deps.json', () => {
  it('classifies every native dependency of the root package.json, in step with embed/package.json', () => {
    const isNative = (name: string) =>
      isNativePackage(fs.readdirSync(path.join(repoRoot, 'node_modules', name)));
    const problems = classificationProblems({
      rootPackage: readJson('package.json'),
      embedPackage: readJson('embed/package.json'),
      deps: shippedDeps(),
      isNative,
    });
    expect(problems).toEqual([]);
  });

  it('follows the owner decisions: Q6 and F5 included, §4.2 and B6 exclusions excluded', () => {
    const { included, excluded } = shippedDeps();
    for (const name of ['expo-media-library', 'expo-sharing', 'whisper.rn']) {
      expect(Object.keys(included)).toContain(name);
    }
    for (const name of [
      '@react-native-async-storage/async-storage',
      'expo-notifications',
      'react-native-background-actions',
      'expo-clipboard',
      'expo-status-bar',
      'expo-router',
      'expo-linking',
      'expo-document-picker',
    ]) {
      expect(Object.keys(excluded)).toContain(name);
    }
    expect({ ...included, ...excluded }).not.toHaveProperty(['expo-network']);
  });
});

describe('nativeSymbolProblems (rule 6)', () => {
  it('fails on sqlite3_open or SQLiteDatabase, with the line', () => {
    const files = [
      { path: 'embed/native/ios/A.swift', text: 'import Foundation\nlet x = 1\n' },
      { path: 'embed/native/ios/B.swift', text: 'import SQLite3\n\nsqlite3_open(path, &db)\n' },
      { path: 'embed/packages/p/C.java', text: 'SQLiteDatabase.openDatabase(p, null, 0);' },
    ];
    expect(nativeSymbolProblems(files)).toEqual([
      expect.stringMatching(/^embed\/native\/ios\/B\.swift:3 uses sqlite3_open/),
      expect.stringMatching(/^embed\/packages\/p\/C\.java:1 uses SQLiteDatabase/),
    ]);
  });
});

describe('facadeProblems', () => {
  const facadeFiles = () => {
    const dir = path.join(repoRoot, 'embed/native/ios');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.swift'))
      .map((f) => ({
        path: `embed/native/ios/${f}`,
        text: fs.readFileSync(path.join(dir, f), 'utf8'),
      }));
  };
  const replaceIn = (files: { path: string; text: string }[], from: string | RegExp, to: string) =>
    files.map((f) => ({ ...f, text: f.text.replace(from, to) }));

  it('passes the shipped facade', () => {
    expect(facadeProblems(facadeFiles())).toEqual([]);
  });

  it('fails when the background-session selector is renamed or loses its Bool', () => {
    const renamed = replaceIn(
      facadeFiles(),
      '@objc(handleEventsForBackgroundURLSession:completionHandler:)',
      '@objc(handleBackgroundEvents:completionHandler:)',
    );
    expect(facadeProblems(renamed)).toEqual([
      expect.stringMatching(/handleEventsForBackgroundURLSession:completionHandler:/),
    ]);
    const noBool = replaceIn(facadeFiles(), /\) -> Bool \{/, ') {');
    expect(facadeProblems(noBool)).toHaveLength(1);
  });

  it('fails when PulseKit or shared lose their Objective-C names', () => {
    expect(
      facadeProblems(replaceIn(facadeFiles(), '@objc(PulseKit)', '@objc(PulseKitEmbed)')),
    ).toEqual([expect.stringMatching(/the class PulseKit/)]);
    expect(
      facadeProblems(
        replaceIn(facadeFiles(), '@objc public static let shared', 'public static let shared'),
      ),
    ).toEqual([expect.stringMatching(/static let shared/)]);
  });

  it('accepts the implicit selector of a bare @objc, and ignores a commented-out declaration', () => {
    const base =
      '@objc(PulseKit) public final class PulseKit: NSObject {\n  @objc public static let shared = PulseKit()\n}\n';
    const bare =
      'extension PulseKit {\n  @objc public func handleEventsForBackgroundURLSession(\n' +
      '    _ identifier: String, completionHandler: @escaping () -> Void\n  ) -> Bool { true }\n}\n';
    expect(facadeProblems([{ path: 'a.swift', text: base + bare }])).toEqual([]);
    const commented = bare
      .split('\n')
      .map((l) => `// ${l}`)
      .join('\n');
    expect(facadeProblems([{ path: 'a.swift', text: base + commented }])).toHaveLength(1);
    expect(stripSwiftComments('a /* b\nc */ d // e\nf')).toBe('a   d \nf');
  });
});
