import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ANDROID_ABIS,
  BUILD_CONFIG_FIELDS,
  FUSED_RELEASE_ARTIFACT_ID,
  HOST_RELEASE,
  MARKER,
  patchFusedGradle,
  patchHostManager,
  patchLibraryGradle,
  resolveStamps,
} from './pulsekit-android-gradle';

const repoRoot = path.resolve(__dirname, '../..');
const templates = path.join(repoRoot, 'node_modules/expo-brownfield/plugin/templates/android');

/** A template as expo-brownfield writes it: `${{name}}` replaced (plugin/build/common/filesystem.js). */
function render(file: string, vars: Record<string, string>) {
  return fs
    .readFileSync(path.join(templates, file), 'utf8')
    .replace(/\$\{\{(\w+)\}\}/g, (_, name: string) => {
      if (!(name in vars)) throw new Error(`${file}: no value for ${name}`);
      return vars[name];
    });
}

const vars = {
  packageId: 'com.mieweb.pulse.kit',
  groupId: 'com.mieweb.pulse',
  version: '0.1.0',
  libraryName: 'pulsekit',
};
const libraryGradle = render('build.gradle.kts', vars);
const hostManager = render('ReactNativeHostManager.kt', vars);
const fused = (variant: string) =>
  render('fused/build.gradle.kts', { ...vars, fusedVariant: variant });

const stamps = {
  version: '1.2.3-rc.1',
  build: '42',
  gitSha: '6c4019271fabbb21bdb0d9f426dfe46e6402d45a',
  contractMinor: 3,
  formatVersion: 2,
  dbSchema: 1795114825342,
};
const libraryOptions = {
  javaDir: '../../native/android/src/main/java',
  resDir: '../../native/android/src/main/res',
  manifest: '../../native/android/src/main/AndroidManifest.xml',
  consumerRules: '../../native/android/consumer-rules.pro',
  stamps,
};

/** The text with every marked block taken out, as it was before the transform. */
const withoutBlocks = (text: string) =>
  text.replace(
    new RegExp(`^[ \\t]*// ${MARKER}: begin\\n[\\s\\S]*?^[ \\t]*// ${MARKER}: end\\n`, 'gm'),
    '',
  );
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('patchLibraryGradle', () => {
  const patched = patchLibraryGradle(libraryGradle, libraryOptions);

  it('adds the facade sources, resources, manifest and consumer rules', () => {
    expect(patched).toContain('java.srcDir("../../native/android/src/main/java")');
    expect(patched).toContain('res.srcDir("../../native/android/src/main/res")');
    expect(patched).toContain(
      'manifest.srcFile("../../native/android/src/main/AndroidManifest.xml")',
    );
    expect(patched).toContain('consumerProguardFiles("../../native/android/consumer-rules.pro")');
    // expo-brownfield's own consumer rules stay.
    expect(patched).toContain('consumerProguardFiles("consumer-rules.pro")');
  });

  it('adds the BuildConfig stamps as literals: Strings quoted, the numbers as longs', () => {
    expect(patched).toContain('buildConfigField("String", "PULSEKIT_VERSION", "\\"1.2.3-rc.1\\"")');
    expect(patched).toContain('buildConfigField("String", "PULSEKIT_BUILD", "\\"42\\"")');
    expect(patched).toContain(
      'buildConfigField("String", "PULSEKIT_GIT_SHA", "\\"6c4019271fabbb21bdb0d9f426dfe46e6402d45a\\"")',
    );
    expect(patched).toContain('buildConfigField("long", "PULSEKIT_CONTRACT_MINOR", "3L")');
    expect(patched).toContain('buildConfigField("long", "PULSEKIT_FORMAT_VERSION", "2L")');
    expect(patched).toContain('buildConfigField("long", "PULSEKIT_DB_SCHEMA", "1795114825342L")');
    expect(BUILD_CONFIG_FIELDS.map(([, name]) => count(patched, `"${name}"`))).toEqual([
      1, 1, 1, 1, 1, 1,
    ]);
  });

  it('leaves the rest of the file unchanged', () => {
    expect(patched.startsWith(libraryGradle)).toBe(true);
    expect(withoutBlocks(patched)).toBe(libraryGradle);
  });

  it('is idempotent, and a second run with new stamps replaces the block', () => {
    expect(patchLibraryGradle(patched, libraryOptions)).toBe(patched);
    const bumped = patchLibraryGradle(patched, {
      ...libraryOptions,
      stamps: { ...stamps, build: '43' },
    });
    expect(count(bumped, `// ${MARKER}: begin`)).toBe(1);
    expect(bumped).toContain('"PULSEKIT_BUILD", "\\"43\\""');
    expect(bumped).not.toContain('"\\"42\\""');
  });

  it('sets the Maven version when PULSEKIT_VERSION is given', () => {
    expect(libraryGradle).toMatch(/^version = "0\.1\.0"$/m);
    const versioned = patchLibraryGradle(libraryGradle, { ...libraryOptions, version: '1.2.3' });
    expect(versioned).toMatch(/^version = "1\.2\.3"$/m);
    expect(versioned).not.toContain('version = "0.1.0"');
    expect(patchLibraryGradle(versioned, { ...libraryOptions, version: '1.2.3' })).toBe(versioned);
    expect(() => patchLibraryGradle(libraryGradle, { ...libraryOptions, version: '1 2' })).toThrow(
      /not a Maven version/,
    );
  });

  it('refuses a stamp that is not a whole number', () => {
    expect(() =>
      patchLibraryGradle(libraryGradle, {
        ...libraryOptions,
        stamps: { ...stamps, dbSchema: 1.5 },
      }),
    ).toThrow(/not a whole number/);
  });
});

describe('patchHostManager', () => {
  const patched = patchHostManager(hostManager);

  it('adds release(reason), which destroys the instance and keeps the cached host', () => {
    expect(HOST_RELEASE).toBe('destroy');
    expect(patched).toContain(
      '  fun release(reason: String) {\n    reactHost?.destroy(reason, null)\n  }',
    );
    // The host object stays: nothing sets reactHost to null.
    expect(patched).not.toMatch(/reactHost\s*=\s*null/);
    // It sits inside the class, right after getReactHost().
    const getter = patched.indexOf('fun getReactHost()');
    const release = patched.indexOf('fun release(reason: String)');
    const initialize = patched.indexOf('fun initialize(');
    expect(getter).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(getter);
    expect(initialize).toBeGreaterThan(release);
  });

  it('is idempotent and leaves the rest of the file unchanged', () => {
    expect(patchHostManager(patched)).toBe(patched);
    expect(withoutBlocks(patched)).toBe(hostManager);
  });

  it('reloads in place in the S1 fallback mode', () => {
    const reload = patchHostManager(patched, { mode: 'reload' });
    expect(reload).toContain('reactHost?.reload(reason)');
    expect(reload).not.toContain('destroy(reason');
    expect(count(reload, 'fun release(')).toBe(1);
  });

  it('refuses a file without getReactHost()', () => {
    expect(() => patchHostManager('class ReactNativeHostManager {}\n')).toThrow(
      /getReactHost\(\) not found/,
    );
  });
});

describe('patchFusedGradle', () => {
  it('gives the release publication the frozen artifactId inside its MavenPublication', () => {
    expect(FUSED_RELEASE_ARTIFACT_ID).toBe('pulsekit');
    const release = fused('release');
    const patched = patchFusedGradle(release, { variant: 'release' });
    const register = patched.indexOf(
      'register<MavenPublication>("brownfield${fusedVariantCapitalized}") {',
    );
    const artifactId = patched.indexOf('artifactId = "pulsekit"');
    expect(register).toBeGreaterThan(-1);
    expect(artifactId).toBeGreaterThan(register);
    expect(artifactId).toBeLessThan(patched.indexOf('afterEvaluate { from(components['));
    expect(withoutBlocks(patched)).toBe(release);
    expect(patchFusedGradle(patched, { variant: 'release' })).toBe(patched);
  });

  it('leaves the debug publication named as expo-brownfield names it, with every ABI', () => {
    const debug = fused('debug');
    const patched = patchFusedGradle(debug, { variant: 'debug' });
    expect(patched).not.toContain('artifactId = "');
    expect(patched).not.toContain('pulsekitDroppedAbis');
    expect(patched).not.toContain('eachFile');
    expect(patched).toContain('android.buildTypes.findByName("debug")');
    expect(withoutBlocks(patched)).toBe(debug);
    expect(patchFusedGradle(patched, { variant: 'debug' })).toBe(patched);
  });

  it('bundles the consumer R8 rules of every library module as the AAR proguard.txt', () => {
    const release = fused('release');
    const patched = patchFusedGradle(release, { variant: 'release' });
    // A block of its own at the end of the file, after the artifactId one.
    const begin = patched.lastIndexOf(`// ${MARKER}: begin`);
    expect(patched.slice(0, begin)).toContain('artifactId = "pulsekit"');
    expect(patched.startsWith(release)).toBe(false); // the artifactId block sits inside it
    expect(patched.trimEnd().endsWith(`// ${MARKER}: end`)).toBe(true);
    const rules = patched.slice(begin);
    expect(rules).toContain('if (findProperty("brownfield.fused") == "true") {');
    expect(rules).toContain('tasks.register("pulsekitConsumerRules")');
    expect(rules).toContain('layout.buildDirectory.file("pulsekit/proguard.txt")');
    expect(rules).toContain(
      'sub.extensions.findByName("android") as? com.android.build.api.dsl.LibraryExtension',
    );
    expect(rules).toContain('android.defaultConfig.consumerProguardFiles');
    expect(rules).toContain('android.buildTypes.findByName("release")');
    expect(rules).toContain(
      '.matching { it.javaClass.name.startsWith("com.android.build.gradle.tasks.FusedLibraryBundleAar") }',
    );
    expect(rules).toContain('from(pulsekitRules)');
    // Kotlin's string templates and escapes come through as Kotlin source.
    expect(rules).toContain(
      '"# --- ${f.relativeTo(pulsekitRulesRoot).invariantSeparatorsPath}\\n${f.readText()}"',
    );
    expect(rules).toContain('sources.joinToString("\\n")');
    // Balanced braces and parentheses: the block is one whole statement.
    expect(count(rules, '{')).toBe(count(rules, '}'));
    expect(count(rules, '(')).toBe(count(rules, ')'));
  });

  it('ships only the given ABIs in the release AAR, dropping the rest from jni/', () => {
    const release = fused('release');
    const abis = ['arm64-v8a', 'armeabi-v7a'];
    const patched = patchFusedGradle(release, { variant: 'release', abis });
    expect(patched).toContain('val pulsekitDroppedAbis = setOf("x86", "x86_64")');
    expect(patched).toContain(
      'if (parts.size > 2 && parts[0] == "jni" && parts[1] in pulsekitDroppedAbis) this.exclude()',
    );
    expect(withoutBlocks(patched)).toBe(release);
    expect(patchFusedGradle(patched, { variant: 'release', abis })).toBe(patched);
    // x86_64 in the list drops only the others; all four drop nothing.
    expect(
      patchFusedGradle(release, { variant: 'release', abis: ['arm64-v8a', 'x86_64'] }),
    ).toContain('setOf("armeabi-v7a", "x86")');
    expect(
      patchFusedGradle(release, { variant: 'release', abis: [...ANDROID_ABIS] }),
    ).not.toContain('pulsekitDroppedAbis');
    expect(() => patchFusedGradle(release, { variant: 'release', abis: ['mips'] })).toThrow(
      /unknown ABI\(s\) mips/,
    );
    expect(() => patchFusedGradle(release, { variant: 'release', abis: [] })).toThrow(
      /no ABIs to ship/,
    );
  });

  it('sets the Maven version when PULSEKIT_VERSION is given', () => {
    const patched = patchFusedGradle(fused('release'), { variant: 'release', version: '2.0.0' });
    expect(patched).toMatch(/^version = "2\.0\.0"$/m);
    expect(patchFusedGradle(patched, { variant: 'release', version: '2.0.0' })).toBe(patched);
  });
});

describe('resolveStamps', () => {
  const source = { version: '2.6.0', contractMinor: 0, formatVersion: 2, dbSchema: 7 };
  const git = { commitCount: () => '1200', head: () => 'abcdef1234567' };

  it('takes the app version, the commit count and HEAD by default', () => {
    expect(resolveStamps(source, {}, git)).toEqual({
      version: '2.6.0',
      build: '1200',
      gitSha: 'abcdef1234567',
      contractMinor: 0,
      formatVersion: 2,
      dbSchema: 7,
    });
  });

  it('prefers PULSEKIT_VERSION, PULSEKIT_BUILD and PULSEKIT_GIT_SHA, then GITHUB_RUN_NUMBER', () => {
    const fail = {
      commitCount: () => fail.never(),
      head: () => fail.never(),
      never: (): string => {
        throw new Error('git should not run');
      },
    };
    expect(
      resolveStamps(
        source,
        { PULSEKIT_VERSION: '3.0.0-rc.2', PULSEKIT_BUILD: '9', PULSEKIT_GIT_SHA: 'fedcba9' },
        fail,
      ),
    ).toMatchObject({ version: '3.0.0-rc.2', build: '9', gitSha: 'fedcba9' });
    expect(
      resolveStamps(source, { GITHUB_RUN_NUMBER: '77', PULSEKIT_VERSION: '' }, git),
    ).toMatchObject({ version: '2.6.0', build: '77' });
  });
});

describe('with-pulsekit-android (the finalized mod on a generated module)', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-android-'));
    const kit = path.join(dir, 'pulsekit');
    fs.mkdirSync(path.join(kit, 'src/main/java/com/mieweb/pulse/kit'), { recursive: true });
    fs.writeFileSync(path.join(kit, 'build.gradle.kts'), libraryGradle);
    fs.writeFileSync(
      path.join(kit, 'src/main/java/com/mieweb/pulse/kit/ReactNativeHostManager.kt'),
      hostManager,
    );
    for (const variant of ['release', 'debug']) {
      fs.mkdirSync(path.join(dir, `pulsekit-fused-${variant}`));
      fs.writeFileSync(
        path.join(dir, `pulsekit-fused-${variant}`, 'build.gradle.kts'),
        fused(variant),
      );
    }
    process.env.PULSEKIT_BUILD = '42';
    process.env.PULSEKIT_GIT_SHA = 'abcdef1234567';
    delete process.env.PULSEKIT_VERSION;
  });
  afterEach(() => {
    process.env = { ...saved };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // embed/app.json's plugins: the mod takes the release ABIs from expo-build-properties.
  const embedPlugins = JSON.parse(fs.readFileSync(path.join(repoRoot, 'embed/app.json'), 'utf8'))
    .expo.plugins;

  /** Runs the plugin's finalized mod as `expo prebuild` would, with the generated module in `dir`. */
  async function prebuild(plugins: unknown[] = embedPlugins) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const withPulseKitAndroid = require('./with-pulsekit-android');
    const config = withPulseKitAndroid({ name: 'Pulse', slug: 'pulse', plugins });
    await config.mods.android.finalized({
      ...config,
      modRequest: { platform: 'android', platformProjectRoot: dir, projectRoot: path.dirname(dir) },
    });
  }
  const snapshot = () =>
    [
      'pulsekit/build.gradle.kts',
      'pulsekit/src/main/java/com/mieweb/pulse/kit/ReactNativeHostManager.kt',
      'pulsekit-fused-release/build.gradle.kts',
      'pulsekit-fused-debug/build.gradle.kts',
    ].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));

  it('patches the module, with paths to embed/native/android, and a second prebuild changes nothing', async () => {
    await prebuild();
    const first = snapshot();
    const rel = path.relative(
      path.join(dir, 'pulsekit'),
      path.join(repoRoot, 'embed/native/android'),
    );
    expect(first[0]).toContain(`java.srcDir("${rel}/src/main/java")`);
    expect(first[0]).toContain('buildConfigField("String", "PULSEKIT_BUILD", "\\"42\\"")');
    expect(first[1]).toContain('fun release(reason: String)');
    expect(first[2]).toContain('artifactId = "pulsekit"');
    // Release ships embed/app.json's buildArchs (arm64-v8a, armeabi-v7a); debug keeps every ABI.
    expect(first[2]).toContain('val pulsekitDroppedAbis = setOf("x86", "x86_64")');
    expect(first[2]).toContain('from(pulsekitRules)');
    expect(first[3]).toContain('from(pulsekitRules)');
    expect(first[3]).not.toContain('pulsekitDroppedAbis');
    expect(withoutBlocks(first[3]).replace(/^version = ".*"$/m, 'version = "0.1.0"')).toBe(
      fused('debug'),
    );
    await prebuild();
    expect(snapshot()).toEqual(first);
  });

  it('publishes at the app version when PULSEKIT_VERSION is unset, as BuildConfig reports', async () => {
    const appVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
      .version as string;
    expect(appVersion).not.toBe('0.1.0'); // embed/app.json's brownfield version, which this replaces
    await prebuild();
    const [library, , release, debug] = snapshot();
    const line = new RegExp(`^version = "${appVersion.replace(/\./g, '\\.')}"$`, 'm');
    for (const text of [library, release, debug]) expect(text).toMatch(line);
    expect(library).toContain(`"PULSEKIT_VERSION", "\\"${appVersion}\\""`);
  });

  it('refuses a config without buildArchs, so a release AAR never ships every ABI', async () => {
    await expect(prebuild([['expo-build-properties', { android: {} }]])).rejects.toThrow(
      /no android\.buildArchs/,
    );
  });

  it('publishes at PULSEKIT_VERSION when it is set', async () => {
    process.env.PULSEKIT_VERSION = '0.2.0-rc.1';
    await prebuild();
    const [library, , release, debug] = snapshot();
    for (const text of [library, release, debug])
      expect(text).toMatch(/^version = "0\.2\.0-rc\.1"$/m);
    expect(library).toContain('"PULSEKIT_VERSION", "\\"0.2.0-rc.1\\""');
  });
});
