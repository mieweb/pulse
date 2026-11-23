import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parsePom } from './android-aar.mjs';
import {
  addModuleDependencies,
  addPomDependencies,
  BASELINE_RUNTIME_DEPENDENCIES,
  missingBaseline,
  moduleDependencies,
  moduleFileOf,
  parseDependencyReport,
  resolveBaseline,
} from './android-metadata.mjs';
import { centralPomProblems } from './maven-central.mjs';

// The fixtures are cut from spike S1's real fused publication (expo-brownfield 57.0.25, renamed
// to the frozen com.mieweb.pulse:pulsekit coordinates) and its `:pulsekit:dependencies` report.
const fixtures = path.join(__dirname, '__fixtures__/android-metadata');
const pubDir = 'com/mieweb/pulse/pulsekit/0.2.0';
const pom = fs.readFileSync(path.join(fixtures, 'repo', pubDir, 'pulsekit-0.2.0.pom'), 'utf8');
const moduleText = fs.readFileSync(
  path.join(fixtures, 'repo', pubDir, 'pulsekit-0.2.0.module'),
  'utf8',
);
const report = fs.readFileSync(path.join(fixtures, 'pulsekit-dependencies.txt'), 'utf8');
const BASELINE = BASELINE_RUNTIME_DEPENDENCIES.map((d) => `${d.group}:${d.artifact}`);

describe('the fused publication as expo-brownfield writes it (S1-b)', () => {
  it('declares none of the baseline modules in its POM or its .module', () => {
    expect(missingBaseline(parsePom(pom).dependencies)).toEqual(BASELINE);
    expect(missingBaseline(moduleDependencies(moduleText))).toEqual(BASELINE);
  });

  it('excludes kotlinx and guava on the edges it does publish', () => {
    expect(pom).toMatch(
      /<groupId>org\.jetbrains\.kotlinx<\/groupId>\s*<artifactId>\*<\/artifactId>/,
    );
    expect(pom).toMatch(/<groupId>com\.google\.guava<\/groupId>\s*<artifactId>\*<\/artifactId>/);
  });
});

describe('parseDependencyReport', () => {
  const versions = parseDependencyReport(report);

  it('reads the resolved version of each module, after any conflict resolution', () => {
    expect(versions.get('com.google.guava:guava')).toBe('33.3.1-android');
    expect(versions.get('org.jetbrains.kotlinx:kotlinx-coroutines-android')).toBe('1.10.2');
    expect(versions.get('org.jetbrains.kotlinx:kotlinx-coroutines-guava')).toBe('1.10.2');
    expect(versions.get('org.jetbrains.kotlinx:atomicfu')).toBe('0.28.0');
    expect(versions.get('org.jetbrains.kotlinx:kotlinx-serialization-core')).toBe('1.7.3');
    expect(versions.get('androidx.appcompat:appcompat')).toBe('1.7.1');
  });

  it('takes a version without a requested one, and a substitution as its target', () => {
    expect(versions.get('com.facebook.react:react-android')).toBe('0.86.3');
    expect(versions.has('com.facebook.react:react-native')).toBe(false);
  });

  it('skips constraints, unresolved entries and projects, and ignores ANSI colours', () => {
    const text = [
      'releaseRuntimeClasspath - Runtime classpath.',
      '+--- \x1b[32mcom.a:x:1.0\x1b[0m',
      '+--- com.a:only-a-constraint:2.0 (c)',
      '+--- com.a:not-resolved:3.0 (n)',
      '+--- project :some-module',
      '\\--- com.a:strict:{strictly 4.0} -> 4.0',
      '',
      'debugRuntimeClasspath - Runtime classpath.',
      '\\--- com.a:debug-only:5.0',
    ].join('\n');
    expect([...parseDependencyReport(text)]).toEqual([
      ['com.a:x', '1.0'],
      ['com.a:strict', '4.0'],
    ]);
  });

  it('refuses a report without the configuration, or with two versions of one module', () => {
    expect(() => parseDependencyReport('debugRuntimeClasspath - x\n+--- a:b:1\n')).toThrow(
      /no "releaseRuntimeClasspath"/,
    );
    expect(() =>
      parseDependencyReport('releaseRuntimeClasspath - x\n+--- a:b:1\n+--- a:b:2\n'),
    ).toThrow(/a:b resolves to both 1 and 2/);
  });
});

describe('resolveBaseline', () => {
  it("keeps S1's versions when there's no report", () => {
    expect(resolveBaseline(null)).toEqual({
      dependencies: BASELINE_RUNTIME_DEPENDENCIES,
      changed: [],
    });
  });

  it('takes the versions the build resolved, and names each one that moved', () => {
    const resolved = parseDependencyReport(report);
    resolved.set('org.jetbrains.kotlinx:atomicfu', '0.29.0');
    const { dependencies, changed } = resolveBaseline(resolved);
    expect(dependencies.find((d) => d.artifact === 'atomicfu')?.version).toBe('0.29.0');
    expect(changed).toEqual(['org.jetbrains.kotlinx:atomicfu: 0.28.0 -> 0.29.0']);
  });

  it("refuses a report that doesn't resolve a baseline module", () => {
    const resolved = parseDependencyReport(report);
    resolved.delete('com.google.guava:guava');
    expect(() => resolveBaseline(resolved)).toThrow(/doesn't resolve com\.google\.guava:guava/);
  });
});

describe('addPomDependencies', () => {
  const { xml, added, present } = addPomDependencies(pom, BASELINE_RUNTIME_DEPENDENCIES);

  it('adds every baseline module as a runtime dependency at its version', () => {
    expect(added).toEqual(BASELINE);
    expect(present).toEqual([]);
    const deps = parsePom(xml).dependencies;
    expect(missingBaseline(deps)).toEqual([]);
    expect(deps.find((d) => d.artifact === 'guava')).toEqual({
      group: 'com.google.guava',
      artifact: 'guava',
      version: '33.3.1-android',
      scope: 'runtime',
      optional: false,
    });
    // Everything the POM had stays, in order, ahead of the additions.
    expect(deps.slice(0, parsePom(pom).dependencies.length)).toEqual(parsePom(pom).dependencies);
  });

  it('keeps the Gradle-metadata marker and the coordinates', () => {
    expect(xml).toContain('<!-- do_not_remove: published-with-gradle-metadata -->');
    expect(parsePom(xml)).toMatchObject({
      group: 'com.mieweb.pulse',
      artifact: 'pulsekit',
      version: '0.2.0',
    });
  });

  it('is idempotent, and leaves a module the POM already declares at its own version', () => {
    expect(addPomDependencies(xml, BASELINE_RUNTIME_DEPENDENCIES)).toEqual({
      xml,
      added: [],
      present: BASELINE,
    });
    const newer = [{ group: 'com.google.guava', artifact: 'guava', version: '99.0' }];
    expect(addPomDependencies(xml, newer).xml).toBe(xml);
  });

  it("makes a <dependencies> block when there's none, and ignores dependencyManagement's", () => {
    const bare =
      '<project>\n  <groupId>g</groupId>\n  <dependencyManagement>\n    <dependencies>\n' +
      '      <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId>' +
      '</dependency>\n    </dependencies>\n  </dependencyManagement>\n</project>\n';
    const out = addPomDependencies(bare, BASELINE_RUNTIME_DEPENDENCIES);
    expect(out.added).toEqual(BASELINE);
    expect(missingBaseline(parsePom(out.xml).dependencies)).toEqual([]);
    expect(out.xml).toMatch(/<\/dependencyManagement>\n {2}<dependencies>\n/);
  });
});

describe('addModuleDependencies', () => {
  const { text, added } = addModuleDependencies(moduleText, BASELINE_RUNTIME_DEPENDENCIES);

  it('adds every baseline module to the runtime variant, in the form Gradle reads', () => {
    expect(added).toEqual(BASELINE);
    expect(missingBaseline(moduleDependencies(text))).toEqual([]);
    const runtime = JSON.parse(text).variants.find(
      (v: { name: string }) => v.name === 'runtimePublication',
    );
    expect(runtime.dependencies).toContainEqual({
      group: 'org.jetbrains.kotlinx',
      module: 'atomicfu',
      version: { requires: '0.28.0' },
    });
  });

  it('changes nothing else: the AAR entry, the excludes and the BuildTypeAttr annotations stay', () => {
    const before = JSON.parse(moduleText);
    const after = JSON.parse(text);
    expect(after.component).toEqual(before.component);
    expect(after.variants[0].files).toEqual(before.variants[0].files);
    expect(after.variants[0].dependencies.slice(0, before.variants[0].dependencies.length)).toEqual(
      before.variants[0].dependencies,
    );
    // Gradle's own layout: 4-space indent, no newline at the end.
    expect(text.startsWith('{\n    "formatVersion": "1.1",')).toBe(true);
    expect(text.endsWith('}')).toBe(true);
  });

  it('is idempotent: a complete file comes back byte for byte', () => {
    expect(addModuleDependencies(text, BASELINE_RUNTIME_DEPENDENCIES)).toEqual({
      text,
      added: [],
      present: BASELINE,
    });
  });

  it('refuses a .module without a runtime variant', () => {
    const api = JSON.stringify({
      variants: [{ name: 'api', attributes: { 'org.gradle.usage': 'java-api' } }],
    });
    expect(() => addModuleDependencies(api, BASELINE_RUNTIME_DEPENDENCIES)).toThrow(
      /no runtime variant/,
    );
  });
});

describe('moduleDependencies', () => {
  it('reads each variant’s dependencies with a scope from its usage', () => {
    const text = JSON.stringify({
      variants: [
        {
          attributes: { 'org.gradle.usage': 'java-api' },
          dependencies: [{ group: 'a', module: 'b', version: { strictly: '1', requires: '0' } }],
        },
        {
          attributes: { 'org.gradle.usage': 'java-runtime' },
          dependencies: [
            { group: 'a', module: 'b', version: { requires: '1' } },
            { group: 'a', module: 'c' },
          ],
        },
      ],
    });
    expect(moduleDependencies(text)).toEqual([
      { group: 'a', artifact: 'b', version: '1', scope: 'compile', optional: false },
      { group: 'a', artifact: 'b', version: '1', scope: 'runtime', optional: false },
      { group: 'a', artifact: 'c', version: null, scope: 'runtime', optional: false },
    ]);
  });

  it('names the .module next to a POM', () => {
    expect(moduleFileOf({ dir: pubDir, artifact: 'pulsekit', version: '0.2.0' })).toBe(
      `${pubDir}/pulsekit-0.2.0.module`,
    );
  });
});

describe('complete-android-metadata.mjs on a copy of the fixture repository', () => {
  const script = path.resolve(__dirname, '../complete-android-metadata.mjs');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const sha1 = (file: string) =>
    crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

  function copyRepo() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsekit-metadata-'));
    fs.cpSync(path.join(fixtures, 'repo'), tmp, { recursive: true });
    const dir = path.join(tmp, pubDir);
    // What Gradle writes next to each file: the hex digest, no newline.
    for (const f of ['pulsekit-0.2.0.pom', 'pulsekit-0.2.0.module']) {
      for (const a of ['md5', 'sha1', 'sha256', 'sha512']) {
        const data = fs.readFileSync(path.join(dir, f));
        fs.writeFileSync(
          path.join(dir, `${f}.${a}`),
          crypto.createHash(a).update(data).digest('hex'),
        );
      }
    }
    return { tmp, dir };
  }

  it('--check fails on the build output, then the run completes it and --check passes', () => {
    const { tmp, dir } = copyRepo();
    try {
      const before = run('--maven', tmp, '--check');
      expect(before.status).toBe(1);
      expect(before.stderr).toMatch(/incomplete metadata in .*pulsekit-0\.2\.0\.pom/);

      const fixed = run(
        '--maven',
        tmp,
        '--resolved',
        path.join(fixtures, 'pulsekit-dependencies.txt'),
      );
      expect(fixed.status).toBe(0);
      expect(fixed.stdout).toMatch(/\.module dependencies added: com\.google\.guava:guava/);

      const pomOut = fs.readFileSync(path.join(dir, 'pulsekit-0.2.0.pom'), 'utf8');
      const moduleOut = fs.readFileSync(path.join(dir, 'pulsekit-0.2.0.module'), 'utf8');
      expect(missingBaseline(parsePom(pomOut).dependencies)).toEqual([]);
      expect(missingBaseline(moduleDependencies(moduleOut))).toEqual([]);
      expect(centralPomProblems(pomOut)).toEqual([]);
      // The checksums Gradle wrote match the new bytes.
      for (const f of ['pulsekit-0.2.0.pom', 'pulsekit-0.2.0.module']) {
        expect(fs.readFileSync(path.join(dir, `${f}.sha1`), 'utf8')).toBe(sha1(path.join(dir, f)));
      }

      expect(run('--maven', tmp, '--check').status).toBe(0);
      const again = run('--maven', tmp);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('Nothing to change.');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses a publication without a .module', () => {
    const { tmp, dir } = copyRepo();
    try {
      fs.rmSync(path.join(dir, 'pulsekit-0.2.0.module'));
      const r = run('--maven', tmp);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/has no pulsekit-0\.2\.0\.module/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
