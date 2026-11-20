import { describe, expect, it } from '@jest/globals';
import { unzipSync } from 'fflate';
import fs from 'node:fs';
import path from 'node:path';

import {
  abiProblems,
  ALLOWED_PERMISSIONS,
  androidBuildSettings,
  dependencyProblem,
  findPublications,
  formatDependencies,
  MIN_SDK_FLOOR,
  missingFacadeClasses,
  mavenZipEntries,
  nativeLibraries,
  parseManifest,
  parsePom,
  permissionCheck,
  r8Problems,
  RELEASE_ABIS,
  REMOVED_PERMISSIONS,
  repositoryProblems,
  sortDependencies,
  zipFiles,
} from './android-aar.mjs';

const embed = path.resolve(__dirname, '../..');
const P = 'android.permission.';

const manifest = (body: string, extra = '') => `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools" ${extra}>
${body}
</manifest>`;

describe('ABIs', () => {
  const entries = (abis: Record<string, string[]>) => [
    'classes.jar',
    'jni/',
    ...Object.entries(abis).flatMap(([abi, libs]) => [
      `jni/${abi}/`,
      ...libs.map((l) => `jni/${abi}/${l}`),
    ]),
  ];
  const libs = ['libappmodules.so', 'libreactnative.so'];

  it('groups jni/<abi>/*.so entries by ABI and ignores everything else', () => {
    const byAbi = nativeLibraries([
      ...entries({ 'armeabi-v7a': [...libs].reverse(), 'arm64-v8a': libs }),
      'jni/arm64-v8a/README.txt',
      'assets/index.android.bundle',
    ]);
    expect([...byAbi]).toEqual([
      ['arm64-v8a', libs],
      ['armeabi-v7a', libs],
    ]);
  });

  it('passes exactly the expected ABIs, each with the same libraries', () => {
    const byAbi = nativeLibraries(entries({ 'arm64-v8a': libs, 'armeabi-v7a': libs }));
    expect(abiProblems(byAbi, RELEASE_ABIS)).toEqual([]);
  });

  it('refuses a missing ABI', () => {
    const byAbi = nativeLibraries(entries({ 'arm64-v8a': libs }));
    expect(abiProblems(byAbi, RELEASE_ABIS)).toEqual(['missing ABI(s): armeabi-v7a']);
  });

  it('refuses an extra ABI (x86_64 belongs to debug builds only)', () => {
    const byAbi = nativeLibraries(
      entries({ 'arm64-v8a': libs, 'armeabi-v7a': libs, x86_64: libs }),
    );
    expect(abiProblems(byAbi, RELEASE_ABIS)).toEqual(['unexpected ABI(s): x86_64 (2 libraries)']);
    expect(abiProblems(byAbi, [...RELEASE_ABIS, 'x86_64'])).toEqual([]);
  });

  it('refuses an ABI that only prebuilt dependencies filled (as in spike S1)', () => {
    const byAbi = nativeLibraries(
      entries({
        'arm64-v8a': ['libappmodules.so', 'libexpo-sqlite.so'],
        'armeabi-v7a': ['libexpo-sqlite.so'],
      }),
    );
    expect(abiProblems(byAbi, RELEASE_ABIS)).toEqual(['armeabi-v7a lacks libappmodules.so']);
  });
});

describe('parseManifest', () => {
  it('reads minSdkVersion 24 and 29', () => {
    expect(parseManifest(manifest('<uses-sdk android:minSdkVersion="24" />')).minSdk).toBe(24);
    expect(
      parseManifest(
        manifest('<uses-sdk android:minSdkVersion="29" android:targetSdkVersion="36"/>'),
      ).minSdk,
    ).toBe(29);
    expect(parseManifest(manifest('')).minSdk).toBeNull();
  });

  it('tells removal markers from requests, reads maxSdkVersion and skips comments', () => {
    const { permissions } = parseManifest(
      manifest(`
    <uses-permission android:name="android.permission.CAMERA" />
    <!-- <uses-permission android:name="android.permission.READ_CONTACTS" /> -->
    <uses-permission
        android:name="android.permission.WRITE_EXTERNAL_STORAGE"
        android:maxSdkVersion="28" />
    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" tools:node="remove" />
    <uses-permission-sdk-23 android:name="android.permission.VIBRATE" />`),
    );
    expect(permissions).toEqual([
      { name: `${P}CAMERA`, maxSdk: null, removed: false },
      { name: `${P}WRITE_EXTERNAL_STORAGE`, maxSdk: 28, removed: false },
      { name: `${P}READ_MEDIA_VIDEO`, maxSdk: null, removed: true },
      { name: `${P}VIBRATE`, maxSdk: null, removed: false },
    ]);
  });

  it('takes the android and tools prefixes from their xmlns declarations', () => {
    const xml = `<manifest xmlns:a="http://schemas.android.com/apk/res/android"
      xmlns:t="http://schemas.android.com/tools">
      <uses-sdk a:minSdkVersion="24"/>
      <uses-permission a:name="android.permission.READ_MEDIA_IMAGES" t:node="remove"/>
    </manifest>`;
    expect(parseManifest(xml)).toEqual({
      minSdk: 24,
      permissions: [{ name: `${P}READ_MEDIA_IMAGES`, maxSdk: null, removed: true }],
    });
  });
});

describe('permissionCheck', () => {
  const check = (body: string) => permissionCheck(parseManifest(manifest(body)).permissions);

  it('passes requests on the allowlist', () => {
    const result = check(`
      <uses-permission android:name="android.permission.CAMERA" />
      <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />
      <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />`);
    expect(result.problems).toEqual([]);
    expect(result.requested.map((p) => p.name)).toEqual([
      `${P}CAMERA`,
      `${P}FOREGROUND_SERVICE_DATA_SYNC`,
      `${P}WRITE_EXTERNAL_STORAGE`,
    ]);
  });

  it('refuses a READ_MEDIA_VIDEO request', () => {
    expect(
      check('<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />').problems,
    ).toEqual([`${P}READ_MEDIA_VIDEO is requested; PulseKit removes it (tools:node="remove")`]);
  });

  it('honours a tools:node="remove" marker over a dependency\'s request', () => {
    const result = check(`
      <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
      <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" tools:node="remove" />`);
    expect(result.problems).toEqual([]);
    expect(result.requested).toEqual([]);
    expect(result.markers).toEqual([`${P}READ_MEDIA_VIDEO`]);
  });

  it('refuses a permission off the allowlist, and a capped one asked for beyond its cap', () => {
    expect(
      check(`
      <uses-permission android:name="android.permission.READ_CONTACTS" />
      <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="32" />`)
        .problems,
    ).toEqual([
      `${P}READ_CONTACTS is requested and isn't on the allowlist`,
      `${P}WRITE_EXTERNAL_STORAGE is requested up to API 32; the allowlist caps it at maxSdkVersion 28`,
    ]);
    expect(
      check('<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />')
        .problems,
    ).toEqual([
      `${P}WRITE_EXTERNAL_STORAGE is requested up to every API level; the allowlist caps it at maxSdkVersion 28`,
    ]);
  });

  it('takes extra allowed permissions', () => {
    const permissions = parseManifest(
      manifest('<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />'),
    ).permissions;
    expect(
      permissionCheck(permissions, {
        allowed: [...ALLOWED_PERMISSIONS, { name: `${P}MODIFY_AUDIO_SETTINGS` }],
      }).problems,
    ).toEqual([]);
  });

  it('matches the library manifest: it requests the allowlist and removes the removed list', () => {
    const xml = fs.readFileSync(
      path.join(embed, 'native/android/src/main/AndroidManifest.xml'),
      'utf8',
    );
    const { minSdk, permissions } = parseManifest(xml);
    expect(minSdk).toBeNull(); // the build sets minSdk; the source manifest doesn't
    const result = permissionCheck(permissions);
    expect(result.problems).toEqual([]);
    expect(result.requested).toEqual(
      ALLOWED_PERMISSIONS.map((p) => ({ name: p.name, maxSdk: p.maxSdk ?? null })).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
    expect(result.markers).toEqual([...REMOVED_PERMISSIONS].sort());
  });
});

describe('parsePom and dependencyProblem', () => {
  const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent><groupId>org.parent</groupId><artifactId>parent</artifactId><version>9</version></parent>
  <groupId>com.mieweb.pulse</groupId>
  <artifactId>pulsekit</artifactId>
  <version>1.2.3</version>
  <packaging>aar</packaging>
  <dependencyManagement><dependencies><dependency>
    <groupId>org.managed</groupId><artifactId>bom</artifactId><version>1</version>
  </dependency></dependencies></dependencyManagement>
  <dependencies>
    <dependency>
      <groupId>com.facebook.react</groupId>
      <artifactId>react-android</artifactId>
      <version>0.86.3</version>
      <scope>runtime</scope>
      <exclusions>
        <exclusion><groupId>com.facebook.yoga</groupId><artifactId>*</artifactId></exclusion>
      </exclusions>
    </dependency>
    <dependency>
      <groupId>androidx.core</groupId>
      <artifactId>core-ktx</artifactId>
    </dependency>
    <!-- <dependency><groupId>x</groupId><artifactId>y</artifactId></dependency> -->
    <dependency>
      <groupId>com.mieweb.pulse</groupId>
      <artifactId>expo-camera</artifactId>
      <version>1.2.3</version>
      <optional>true</optional>
    </dependency>
  </dependencies>
</project>`;

  it("reads the POM's own coordinates and its dependencies, with and without versions", () => {
    const parsed = parsePom(pom);
    expect([parsed.group, parsed.artifact, parsed.version]).toEqual([
      'com.mieweb.pulse',
      'pulsekit',
      '1.2.3',
    ]);
    expect(parsed.dependencies).toEqual([
      {
        group: 'com.facebook.react',
        artifact: 'react-android',
        version: '0.86.3',
        scope: 'runtime',
        optional: false,
      },
      {
        group: 'androidx.core',
        artifact: 'core-ktx',
        version: null,
        scope: 'compile',
        optional: false,
      },
      {
        group: 'com.mieweb.pulse',
        artifact: 'expo-camera',
        version: '1.2.3',
        scope: 'compile',
        optional: true,
      },
    ]);
  });

  it('reads a POM with no dependencies', () => {
    expect(
      parsePom(
        '<project><groupId>g.h</groupId><artifactId>a</artifactId><version>1</version></project>',
      ),
    ).toEqual({ group: 'g.h', artifact: 'a', version: '1', dependencies: [] });
  });

  it('refuses an unresolvable, system-scoped, dev-tooling or leaked dependency', () => {
    const context = {
      ownGroup: 'com.mieweb.pulse',
      shipped: new Set(['com.mieweb.pulse:pulsekit']),
    };
    const [react, core, leaked] = parsePom(pom).dependencies;
    expect(dependencyProblem(react, context)).toBeNull();
    expect(dependencyProblem(core, context)).toBe('androidx.core:core-ktx has no version');
    expect(dependencyProblem(leaked, context)).toBe(
      "com.mieweb.pulse:expo-camera is one of ours, but the repository doesn't hold it",
    );
    expect(
      dependencyProblem(leaked, {
        ...context,
        shipped: new Set([...context.shipped, 'com.mieweb.pulse:expo-camera']),
      }),
    ).toBeNull();
    expect(dependencyProblem({ ...react, scope: 'system' }, context)).toBe(
      'com.facebook.react:react-android has system scope',
    );
    expect(
      dependencyProblem({ ...react, group: 'com.facebook.flipper', artifact: 'flipper' }, context),
    ).toBe('com.facebook.flipper:flipper is developer tooling');
  });

  it('writes the dependency matrix sorted by coordinates', () => {
    const rows = sortDependencies(
      parsePom(pom).dependencies.map((d) => ({ ...d, from: 'pulsekit:1.2.3' })),
    );
    expect(rows.map((r) => r.artifact)).toEqual(['core-ktx', 'react-android', 'expo-camera']);
    const md = formatDependencies({ title: 'Deps', rows });
    expect(md).toContain('| androidx.core | core-ktx | (none) | compile | pulsekit:1.2.3 |');
    expect(md).toContain('| com.mieweb.pulse | expo-camera | 1.2.3 | compile (optional) |');
  });
});

describe('the Maven repository', () => {
  const dir = 'com/mieweb/pulse/pulsekit/1.2.3';
  const files = [
    'com/mieweb/pulse/pulsekit/maven-metadata.xml',
    `${dir}/pulsekit-1.2.3.aar`,
    `${dir}/pulsekit-1.2.3.aar.sha256`,
    `${dir}/pulsekit-1.2.3.module`,
    `${dir}/pulsekit-1.2.3.pom`,
  ];

  it('finds a publication from its POM path', () => {
    expect(findPublications(files)).toEqual([
      {
        group: 'com.mieweb.pulse',
        artifact: 'pulsekit',
        version: '1.2.3',
        dir,
        pom: `${dir}/pulsekit-1.2.3.pom`,
        aar: `${dir}/pulsekit-1.2.3.aar`,
      },
    ]);
    expect(repositoryProblems(findPublications(files))).toEqual([]);
  });

  it('refuses an empty repository, a POM without an AAR, two versions and a debug build', () => {
    expect(repositoryProblems([])).toEqual(['no publication (no <artifact>-<version>.pom) found']);
    const problems = repositoryProblems(
      findPublications([
        ...files,
        'com/mieweb/pulse/pulsekit/1.2.4/pulsekit-1.2.4.pom',
        'com/mieweb/pulse/pulsekit-fused-debug/1.2.3/pulsekit-fused-debug-1.2.3.pom',
        'com/mieweb/pulse/pulsekit-fused-debug/1.2.3/pulsekit-fused-debug-1.2.3.aar',
      ]),
    );
    expect(problems).toEqual([
      'com.mieweb.pulse:pulsekit-fused-debug is a debug build; package a repository that holds a release build only',
      'com.mieweb.pulse:pulsekit:1.2.4 has a POM but no AAR',
      'com.mieweb.pulse:pulsekit is there in 2 versions (1.2.3, 1.2.4); empty the repository and publish once',
    ]);
  });

  it('zips the files in sorted order, without Finder litter, to the same bytes every time', () => {
    const entries = mavenZipEntries([...files].reverse().concat(['.DS_Store', `${dir}/.DS_Store`]));
    expect(entries).toEqual([...files].sort());
    const data = (name: string) => new TextEncoder().encode(`contents of ${name}`);
    const zip = zipFiles(entries.map((name) => ({ name, data: data(name) })));
    const again = zipFiles(entries.map((name) => ({ name, data: data(name) })));
    expect(Buffer.from(again).equals(Buffer.from(zip))).toBe(true);
    const unzipped = unzipSync(zip);
    expect(Object.keys(unzipped)).toEqual(entries);
    expect(new TextDecoder().decode(unzipped[`${dir}/pulsekit-1.2.3.pom`])).toBe(
      `contents of ${dir}/pulsekit-1.2.3.pom`,
    );
    expect(() =>
      zipFiles([
        { name: 'a', data: data('a') },
        { name: 'a', data: data('a') },
      ]),
    ).toThrow(/listed twice/);
  });
});

describe('R8 rules and the facade classes', () => {
  it("accepts the library's consumer-rules.pro", () => {
    const rules = fs.readFileSync(path.join(embed, 'native/android/consumer-rules.pro'), 'utf8');
    expect(r8Problems(rules)).toEqual([]);
  });

  it('refuses an AAR without consumer rules, or rules that miss a keep', () => {
    expect(r8Problems(null)).toEqual([
      "no proguard.txt: a host that minifies would strip PulseKit and Expo's modules",
    ]);
    expect(
      r8Problems(
        '-keep class com.mieweb.pulse.kit.PulseKit { *; }\n# -keep class com.rnwhisper.** { *; }',
      ),
    ).toEqual([
      'proguard.txt has no -keep rule for expo.modules.brownfield.**',
      'proguard.txt has no -keep rule for com.rnwhisper.**',
    ]);
  });

  it('names the facade classes classes.jar lacks', () => {
    expect(
      missingFacadeClasses([
        'com/mieweb/pulse/kit/PulseActivity.class',
        'com/mieweb/pulse/kit/ReactNativeHostManager.class',
      ]),
    ).toEqual([
      'com/mieweb/pulse/kit/PulseKit.class',
      'com/mieweb/pulse/kit/PulseUploadService.class',
    ]);
  });
});

describe('androidBuildSettings', () => {
  it("reads embed/app.json: the release ABIs and the minSdk floor match the check's defaults", () => {
    const app = JSON.parse(fs.readFileSync(path.join(embed, 'app.json'), 'utf8'));
    expect(androidBuildSettings(app)).toEqual({ abis: [...RELEASE_ABIS], minSdk: MIN_SDK_FLOOR });
  });

  it('gives nothing when expo-build-properties says nothing', () => {
    expect(androidBuildSettings({ expo: { plugins: ['expo-sqlite'] } })).toEqual({});
    expect(
      androidBuildSettings({ expo: { plugins: [['expo-build-properties', { ios: {} }]] } }),
    ).toEqual({ abis: undefined, minSdk: undefined });
  });
});
