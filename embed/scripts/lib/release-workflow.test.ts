import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

import { ANDROID_MAVEN_ZIP } from './release-assets.mjs';

// Text checks on the release workflow: it publishes with provenance, so what it runs must not move
// under it, and a failing command must fail its step.
const repoRoot = path.resolve(__dirname, '../../..');
const workflow = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/release-embed.yml'),
  'utf8',
);
const lines = workflow.split('\n');

describe('release-embed.yml', () => {
  it('runs every step in bash, so pipefail is on', () => {
    expect(workflow).toMatch(/^defaults:\n {2}run:\n {4}shell: bash$/m);
    expect(lines.filter((l) => /^\s+shell:/.test(l) && !/shell: bash\s*$/.test(l))).toEqual([]);
  });

  it('pins every action to a commit SHA, with the exact version it is in a comment', () => {
    const uses = lines.filter((l) => /^\s*(- )?uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    const unpinned = uses.filter(
      (l) => !/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(l),
    );
    expect(unpinned).toEqual([]);
  });

  it('pins the checked-out mieweb/actions to a commit SHA', () => {
    expect(workflow).toMatch(/repository: mieweb\/actions\n\s+ref: [0-9a-f]{40} #/);
  });

  it('installs an exact npm version that has trusted publishing (>= 11.5.1)', () => {
    const installs = [...workflow.matchAll(/npm install -g npm@(\S+)/g)].map((m) => m[1]);
    expect(installs).toHaveLength(1);
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(installs[0]);
    expect(match).not.toBeNull();
    const [major, minor, patch] = match!.slice(1).map(Number);
    expect(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)))).toBe(true);
  });

  it('starts only on pulsekit-v tags, dispatch and workflow_call, never on pull requests', () => {
    const on = /^on:\n((?: {2}.*\n|\n)*)/m.exec(workflow);
    expect(on).not.toBeNull();
    const triggers = on![1]
      .split('\n')
      .filter((l) => /^ {2}\w/.test(l))
      .map((l) => l.trim().replace(/:.*$/, ''));
    expect(triggers).toEqual(['push', 'workflow_dispatch', 'workflow_call']);
    expect(on![1]).toMatch(/tags:\n\s+- 'pulsekit-v\*'/);
    expect(on![1]).not.toMatch(/branches/);
  });
});

/**
 * One job's lines: from `  <name>:` under `jobs:` to the next job or the comment above it.
 * @param text The workflow.
 */
function job(text: string, name: string) {
  const all = text.split('\n');
  const start = all.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`no job ${name}`);
  const end = all.findIndex((l, i) => i > start && /^ {2}([\w-]+:$|#)/.test(l));
  return all.slice(start, end < 0 ? undefined : end).join('\n');
}

/** The steps of a job, each as its text from `- ` to the next `- ` at the same indent. */
function steps(block: string) {
  return block.split(/\n(?= {6}- )/).slice(1);
}

describe('release-embed.yml: the Android job (G5)', () => {
  const android = job(workflow, 'android');
  const release = job(workflow, 'release');

  it('builds on Ubuntu, for pulsekit-v tags only, with JDK 21 and Gradle set up', () => {
    expect(android).toMatch(/\n {4}runs-on: ubuntu-latest\n/);
    expect(android).toMatch(
      /\n {4}if: startsWith\(inputs\.tag \|\| github\.ref_name, 'pulsekit-v'\)\n/,
    );
    expect(android).toMatch(
      /uses: actions\/setup-java@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}distribution: temurin\n {10}java-version: '21'/,
    );
    expect(android).toMatch(/uses: gradle\/actions\/setup-gradle@[0-9a-f]{40} # v[\d.]+/);
    expect(android).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+/);
    expect(android).toMatch(/uses: actions\/setup-node@[0-9a-f]{40} # v[\d.]+/);
  });

  it('installs, frees disk, stamps, prebuilds, builds, completes the metadata and packages, in that order', () => {
    // npm ci first: the NDK to keep is read from react-native's libs.versions.toml.
    const order = [
      /run: npm ci/,
      /sudo rm -rf \/usr\/share\/dotnet \/opt\/ghc/,
      /release-version\.mjs.*\n.*stamp "\$VERSION"/,
      /npm run prebuild -- --platform android/,
      /npm run build:android\n/,
      /gradlew :pulsekit:dependencies --configuration releaseRuntimeClasspath/,
      /complete-android-metadata\.mjs --maven "\$MAVEN" --resolved "\$DEPS"/,
      /npm run embed:package:android -- --maven embed\/artifacts\/android-maven --out "\$OUT"/,
    ];
    const at = order.map((re) => android.search(re));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The NDK React Native builds with stays.
    expect(android).toMatch(/ndkVersion/);
    expect(android).toMatch(/df -h \//);
  });

  it('hands the zip, its checksum line and the dependency matrix on as a workflow artifact', () => {
    const upload = steps(android).find((s) => /actions\/upload-artifact@/.test(s));
    expect(upload).toBeDefined();
    expect(upload).toMatch(/name: pulsekit-android\n/);
    expect(upload).toContain(`pulsekit-android/release/${ANDROID_MAVEN_ZIP}`);
    expect(upload).toContain('pulsekit-android/release/SHA256SUMS');
    expect(upload).toContain('pulsekit-android/android-dependencies.md');
    expect(upload).toMatch(/if-no-files-found: error/);
  });

  it('runs before the release job, which fails with it', () => {
    expect(release).toMatch(/\n {4}needs: android\n/);
    // No `if: always()`-style override on the release job: a failed android job skips it.
    expect(release).not.toMatch(/\n {4}if: .*(always|failure)\(\)/);
  });

  it('the release job attaches the Android zip through package-ios.mjs, so SHA256SUMS lists it', () => {
    const all = steps(release);
    const download = all.findIndex((s) => /actions\/download-artifact@[0-9a-f]{40} # v/.test(s));
    const pkg = all.findIndex((s) => /node embed\/scripts\/package-ios\.mjs/.test(s));
    expect(download).toBeGreaterThanOrEqual(0);
    expect(all[download]).toMatch(/name: pulsekit-android\n/);
    expect(pkg).toBeGreaterThan(download);
    expect(all[pkg]).toContain(`--attach "$ANDROID/release/${ANDROID_MAVEN_ZIP}"`);
    // ...and nothing uploads it to the Release a second time: the Release is created once, from
    // package-ios.mjs's release/ folder.
    expect(workflow).not.toMatch(/gh release upload/);
    expect(workflow.match(/gh release create /g)).toHaveLength(1);
    expect(release).toMatch(/gh release create "\$TAG" .* "\$OUT"\/release\/\*\n/);
  });
});

describe('release-embed.yml: Maven Central (O5)', () => {
  const central = job(workflow, 'maven-central');

  it('runs only when the owner sets MAVEN_CENTRAL_PUBLISH, and never for an -rc tag', () => {
    expect(central).toMatch(
      /\n {4}if: vars\.MAVEN_CENTRAL_PUBLISH == 'true' && !contains\(inputs\.tag \|\| github\.ref_name, '-rc\.'\)\n/,
    );
  });

  it('runs after the GitHub Release exists, from the bytes of its zip', () => {
    expect(central).toMatch(/\n {4}needs: \[android, release\]\n/);
    expect(central).toMatch(/sha256sum -c SHA256SUMS/);
    expect(central).toContain(
      `unzip -q "$RUNNER_TEMP/pulsekit-android/release/${ANDROID_MAVEN_ZIP}"`,
    );
    expect(central).toMatch(
      /node embed\/scripts\/publish-maven-central\.mjs --maven "\$RUNNER_TEMP\/android-maven"/,
    );
  });

  it('passes the token and the signing key as secrets, and nothing else publishes to Central', () => {
    for (const name of [
      'MAVEN_CENTRAL_USERNAME',
      'MAVEN_CENTRAL_PASSWORD',
      'MAVEN_GPG_PRIVATE_KEY',
      'MAVEN_GPG_PASSPHRASE',
    ]) {
      expect(central).toContain(`${name}: \${{ secrets.${name} }}`);
      // A caller (workflow_call) may pass them; none is required.
      expect(workflow).toMatch(new RegExp(`\\n {6}${name}:\\n {8}required: false\\n`));
    }
    for (const other of ['android', 'release']) {
      expect(job(workflow, other)).not.toMatch(/publish-maven-central/);
    }
  });
});

describe('ci.yml: the JVM vectors', () => {
  const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const vectors = job(ci, 'jvm-vectors');

  it('runs the Kotlin vectors and the upload rules on Ubuntu with JDK 21 and a pinned Gradle', () => {
    expect(vectors).toMatch(/\n {4}runs-on: ubuntu-latest\n/);
    expect(vectors).toMatch(
      /uses: actions\/setup-java@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}distribution: temurin\n {10}java-version: '21'/,
    );
    expect(vectors).toMatch(
      /uses: gradle\/actions\/setup-gradle@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}gradle-version: '[\d.]+'/,
    );
    expect(vectors).toContain(
      'gradle -p embed/native/android/jvm-tests run --args="$GITHUB_WORKSPACE"',
    );
    expect(vectors).toMatch(/-PmainClass=com\.mieweb\.pulse\.kit\.vectors\.UploadRulesMain/);
  });

  it('pins every action in the job, and builds nothing for Android on a PR', () => {
    const uses = vectors.split('\n').filter((l) => /^\s*(- )?uses:/.test(l));
    expect(uses.length).toBe(3);
    expect(uses.filter((l) => !/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(l))).toEqual([]);
    expect(ci).not.toMatch(/build:android|gradlew|expo-brownfield|prebuild/);
  });
});

describe('release-embed.yml and ci.yml pin each action to one commit', () => {
  it('uses the same SHA for an action everywhere', () => {
    const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const shas = new Map<string, Set<string>>();
    for (const m of `${workflow}\n${ci}`.matchAll(/uses: ([\w.\/-]+)@([0-9a-f]{40})/g)) {
      shas.set(m[1], new Set([...(shas.get(m[1]) ?? []), m[2]]));
    }
    expect([...shas].filter(([, set]) => set.size > 1)).toEqual([]);
  });
});
