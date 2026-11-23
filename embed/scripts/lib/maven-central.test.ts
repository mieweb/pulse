import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { unzipSync } from 'fflate';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findPublications } from './android-aar.mjs';
import {
  addCentralPomInfo,
  assertCentralVersion,
  authorization,
  bundlePlan,
  CENTRAL_API,
  centralPomProblems,
  checksumNames,
  checksumsOf,
  parseStatus,
  parseUploadResponse,
  placeholderJar,
  PULSEKIT_POM_INFO,
  statusRequest,
  uploadRequest,
} from './maven-central.mjs';

const fixtures = path.join(__dirname, '__fixtures__/android-metadata');
const pubDir = 'com/mieweb/pulse/pulsekit/0.2.0';
const fusedPom = fs.readFileSync(path.join(fixtures, 'repo', pubDir, 'pulsekit-0.2.0.pom'), 'utf8');
const pub = { group: 'com.mieweb.pulse', artifact: 'pulsekit', version: '0.2.0', dir: pubDir };

describe('bundlePlan: a fused AAR publication', () => {
  // What the fused build writes: AAR, POM, .module, Gradle's checksums, maven-metadata above.
  const dirFiles = [
    'pulsekit-0.2.0.aar',
    'pulsekit-0.2.0.aar.md5',
    'pulsekit-0.2.0.aar.sha1',
    'pulsekit-0.2.0.aar.sha256',
    'pulsekit-0.2.0.aar.sha512',
    'pulsekit-0.2.0.module',
    'pulsekit-0.2.0.module.sha1',
    'pulsekit-0.2.0.pom',
    'pulsekit-0.2.0.pom.sha1',
  ];
  const plan = bundlePlan(pub, dirFiles);

  it('takes the AAR, POM and .module, and none of the old checksums', () => {
    expect(plan.problems).toEqual([]);
    expect(plan.files).toEqual([
      `${pubDir}/pulsekit-0.2.0.aar`,
      `${pubDir}/pulsekit-0.2.0.module`,
      `${pubDir}/pulsekit-0.2.0.pom`,
    ]);
  });

  it('adds placeholder sources and javadoc jars, which Central requires', () => {
    expect(plan.placeholders).toEqual([
      { path: `${pubDir}/pulsekit-0.2.0-sources.jar`, kind: 'sources' },
      { path: `${pubDir}/pulsekit-0.2.0-javadoc.jar`, kind: 'javadoc' },
    ]);
  });

  it('lists a signature and four checksums for every file, and nothing for those', () => {
    expect(plan.entries).toHaveLength(5 * 6);
    const aar = `${pubDir}/pulsekit-0.2.0.aar`;
    for (const e of [aar, `${aar}.asc`, `${aar}.md5`, `${aar}.sha1`, `${aar}.sha256`])
      expect(plan.entries).toContain(e);
    expect(plan.entries).toContain(`${pubDir}/pulsekit-0.2.0-javadoc.jar.asc`);
    expect(plan.entries.filter((e) => /\.asc\.|\.(md5|sha1)\.(asc|md5)$/.test(e))).toEqual([]);
    expect([...plan.entries].sort()).toEqual(plan.entries);
  });

  it('keeps sources and javadoc jars the build wrote', () => {
    const withJars = bundlePlan(pub, [
      ...dirFiles,
      'pulsekit-0.2.0-sources.jar',
      'pulsekit-0.2.0-javadoc.jar',
    ]);
    expect(withJars.placeholders).toEqual([]);
    expect(withJars.files).toContain(`${pubDir}/pulsekit-0.2.0-sources.jar`);
  });

  it('refuses a folder without a POM or an AAR/JAR, or with another version in it', () => {
    expect(bundlePlan(pub, ['pulsekit-0.2.0.module']).problems).toEqual([
      `${pubDir} has no pulsekit-0.2.0.pom`,
      `${pubDir} has no pulsekit-0.2.0.aar or pulsekit-0.2.0.jar`,
    ]);
    expect(bundlePlan(pub, [...dirFiles, 'pulsekit-0.1.0.aar']).problems).toEqual([
      `${pubDir} holds files of another artifact or version: pulsekit-0.1.0.aar`,
    ]);
  });

  it('matches what findPublications finds in a repository listing', () => {
    const [found] = findPublications(dirFiles.map((f) => `${pubDir}/${f}`));
    expect(bundlePlan(found, dirFiles)).toEqual(plan);
  });
});

describe('checksums', () => {
  it('names .md5, .sha1, .sha256 and .sha512 next to a file', () => {
    expect(checksumNames('a/b-1.0.pom')).toEqual([
      'a/b-1.0.pom.md5',
      'a/b-1.0.pom.sha1',
      'a/b-1.0.pom.sha256',
      'a/b-1.0.pom.sha512',
    ]);
  });

  it('writes the bare hex digests', () => {
    const data = new TextEncoder().encode('abc');
    expect(checksumsOf(data)).toEqual({
      md5: '900150983cd24fb0d6963f7d28e17f72',
      sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      sha512: crypto.createHash('sha512').update('abc').digest('hex'),
    });
  });
});

describe('placeholderJar', () => {
  it('is a valid jar with a manifest and a README, the same bytes every time', () => {
    const jar = placeholderJar('javadoc', 'com.mieweb.pulse:pulsekit:0.2.0');
    expect(Buffer.from(jar)).toEqual(
      Buffer.from(placeholderJar('javadoc', 'com.mieweb.pulse:pulsekit:0.2.0')),
    );
    const files = unzipSync(jar);
    expect(Object.keys(files).sort()).toEqual(['META-INF/MANIFEST.MF', 'README.md']);
    expect(new TextDecoder().decode(files['META-INF/MANIFEST.MF'])).toMatch(/^Manifest-Version/);
    expect(new TextDecoder().decode(files['README.md'])).toContain(PULSEKIT_POM_INFO.url);
  });
});

describe('the POM fields Central requires', () => {
  it('finds every one missing from the fused POM as expo-brownfield writes it', () => {
    expect(centralPomProblems(fusedPom)).toEqual([
      'no <name>',
      'no <description>',
      'no <url>',
      'no <licenses><license>',
      'no <developers><developer>',
      'no <scm>',
    ]);
  });

  it('refuses incomplete licenses, developers and scm, and a SNAPSHOT', () => {
    const pom = `<project>
  <groupId>g</groupId><artifactId>a</artifactId><version>1.0-SNAPSHOT</version>
  <name>n</name><description>d</description><url>u</url>
  <licenses><license><name>MIT</name></license></licenses>
  <developers><developer><id>x</id></developer></developers>
  <scm><url>u</url></scm>
</project>`;
    expect(centralPomProblems(pom)).toEqual([
      'version 1.0-SNAPSHOT is a SNAPSHOT',
      'a <license> lacks <name> or <url>',
      'a <developer> has neither <name> nor <organization>',
      '<scm> has no <connection>',
      '<scm> has no <developerConnection>',
    ]);
  });

  it("doesn't take a dependency's or the parent's fields for the project's", () => {
    const pom = `<project>
  <parent><groupId>p</groupId><artifactId>p</artifactId><version>1</version><name>p</name></parent>
  <groupId>g</groupId><artifactId>a</artifactId><version>1.0</version>
  <dependencies><dependency><url>x</url></dependency></dependencies>
</project>`;
    expect(centralPomProblems(pom)).toEqual(
      expect.arrayContaining(['no <name>', 'no <url>', 'no <description>']),
    );
  });

  it('addCentralPomInfo completes the fused POM, after <packaging>, and only once', () => {
    const { xml, added } = addCentralPomInfo(fusedPom);
    expect(added).toEqual(['name', 'description', 'url', 'licenses', 'developers', 'scm']);
    expect(centralPomProblems(xml)).toEqual([]);
    expect(xml).toMatch(/<packaging>aar<\/packaging>\n {2}<name>PulseKit<\/name>\n/);
    expect(xml).toContain('<role>organization</role>');
    expect(addCentralPomInfo(xml)).toEqual({ xml, added: [] });
  });

  it('names an organisation as the developer, never a person', () => {
    for (const d of PULSEKIT_POM_INFO.developers) {
      expect(d.name).toBe(d.organization);
      expect(d.organizationUrl).toMatch(/^https:\/\/github\.com\//);
    }
  });
});

describe('versions', () => {
  it('keeps release candidates and SNAPSHOTs off Central', () => {
    expect(assertCentralVersion('0.2.0')).toBe('0.2.0');
    expect(() => assertCentralVersion('0.2.0-rc.1')).toThrow(/release candidate/);
    expect(() => assertCentralVersion('0.2.0-SNAPSHOT')).toThrow(/SNAPSHOT/);
    expect(() => assertCentralVersion('0.2.0-beta')).toThrow(/not a final/);
  });
});

describe('requests', () => {
  const auth = 'Bearer ' + Buffer.from('user:pa:ss').toString('base64');

  it('the upload is a multipart POST with a bearer token of base64(username:password)', async () => {
    const bundle = new Uint8Array([1, 2, 3]);
    const { url, init } = uploadRequest({
      username: 'user',
      password: 'pa:ss',
      bundle,
      name: 'pulsekit 0.2.0',
      publishingType: 'USER_MANAGED',
    });
    expect(url).toBe(`${CENTRAL_API}/upload?name=pulsekit+0.2.0&publishingType=USER_MANAGED`);
    expect(init.method).toBe('POST');
    // No Content-Type: fetch writes multipart/form-data with its boundary.
    expect(init.headers).toEqual({ Authorization: auth });
    const part = init.body.get('bundle');
    expect(part).toBeInstanceOf(Blob);
    expect((part as File).name).toBe('central-bundle.zip');
    expect(new Uint8Array(await (part as Blob).arrayBuffer())).toEqual(bundle);
  });

  it('refuses an unknown publishing type and a missing token', () => {
    const base = { bundle: new Uint8Array(), name: 'n' };
    expect(() =>
      uploadRequest({
        ...base,
        username: 'u',
        password: 'p',
        publishingType: 'NOW' as 'AUTOMATIC',
      }),
    ).toThrow(/publishing type NOW/);
    expect(() => authorization('', 'p')).toThrow(/user token is missing/);
  });

  it('the status check is a POST with the deployment id', () => {
    expect(statusRequest({ username: 'user', password: 'pa:ss', id: 'abc-123' })).toEqual({
      url: `${CENTRAL_API}/status?id=abc-123`,
      init: { method: 'POST', headers: { Authorization: auth } },
    });
  });

  it('reads the deployment id from the upload response', () => {
    expect(parseUploadResponse(201, '28570f16-da32-4c14-bd2e-c1acc0782365\n')).toBe(
      '28570f16-da32-4c14-bd2e-c1acc0782365',
    );
    expect(() => parseUploadResponse(401, 'Invalid token')).toThrow(/HTTP 401\): Invalid token/);
    expect(() => parseUploadResponse(201, '<html>')).toThrow(/no deployment ID/);
  });
});

describe('parseStatus', () => {
  it('keeps polling while Central validates', () => {
    for (const state of ['PENDING', 'VALIDATING']) {
      expect(parseStatus({ deploymentState: state }, 'USER_MANAGED')).toMatchObject({
        done: false,
      });
    }
  });

  it('VALIDATED ends a USER_MANAGED deployment, and not an AUTOMATIC one', () => {
    expect(parseStatus({ deploymentState: 'VALIDATED' }, 'USER_MANAGED')).toMatchObject({
      state: 'VALIDATED',
      done: true,
      ok: true,
    });
    expect(parseStatus({ deploymentState: 'VALIDATED' }, 'AUTOMATIC')).toMatchObject({
      done: false,
    });
  });

  it('PUBLISHED is done for either type; PUBLISHING ends an AUTOMATIC one', () => {
    for (const type of ['USER_MANAGED', 'AUTOMATIC'] as const) {
      expect(parseStatus({ deploymentState: 'PUBLISHED' }, type)).toMatchObject({
        done: true,
        ok: true,
      });
    }
    expect(parseStatus({ deploymentState: 'PUBLISHING' }, 'AUTOMATIC')).toMatchObject({
      done: true,
      ok: true,
    });
  });

  it('FAILED is done and not ok, with every error as a line', () => {
    const status = parseStatus(
      {
        deploymentState: 'FAILED',
        errors: {
          'pkg:maven/com.mieweb.pulse/pulsekit@0.2.0': [
            'Missing signature for file: pulsekit-0.2.0.aar',
            'Invalid POM: /pulsekit-0.2.0.pom: Project URL is not defined',
          ],
          common: 'Deployment components info not found',
        },
      },
      'USER_MANAGED',
    );
    expect(status).toMatchObject({ state: 'FAILED', done: true, ok: false });
    expect(status.errors).toEqual([
      'pkg:maven/com.mieweb.pulse/pulsekit@0.2.0: Missing signature for file: pulsekit-0.2.0.aar',
      'pkg:maven/com.mieweb.pulse/pulsekit@0.2.0: Invalid POM: /pulsekit-0.2.0.pom: Project URL is not defined',
      'common: Deployment components info not found',
    ]);
    expect(parseStatus({ deploymentState: 'FAILED', errors: ['x'] }, 'AUTOMATIC').errors).toEqual([
      'x',
    ]);
  });

  it('stops on a state it doesn’t know', () => {
    expect(parseStatus({}, 'AUTOMATIC')).toMatchObject({
      state: 'UNKNOWN',
      done: true,
      ok: false,
    });
  });
});

describe('publish-maven-central.mjs --dry-run on a completed fixture repository', () => {
  const script = path.resolve(__dirname, '../publish-maven-central.mjs');
  const complete = path.resolve(__dirname, '../complete-android-metadata.mjs');

  function repoCopy(version: string) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsekit-central-'));
    const repo = path.join(tmp, 'repo');
    fs.cpSync(path.join(fixtures, 'repo'), repo, { recursive: true });
    const from = path.join(repo, pubDir);
    const dir = path.join(repo, `com/mieweb/pulse/pulsekit/${version}`);
    if (from !== dir) fs.renameSync(from, dir);
    for (const ext of ['pom', 'module']) {
      const oldName = path.join(dir, `pulsekit-0.2.0.${ext}`);
      const text = fs.readFileSync(oldName, 'utf8').replace(/0\.2\.0/g, version);
      fs.rmSync(oldName);
      fs.writeFileSync(path.join(dir, `pulsekit-${version}.${ext}`), text);
    }
    fs.writeFileSync(path.join(dir, `pulsekit-${version}.aar`), 'not really an aar');
    return { tmp, repo };
  }
  const env = { ...process.env };
  delete env.MAVEN_GPG_PRIVATE_KEY;

  it('builds the bundle (unsigned without a key) and lists every file', () => {
    const { tmp, repo } = repoCopy('0.2.0');
    try {
      expect(spawnSync(process.execPath, [complete, '--maven', repo]).status).toBe(0);
      const out = path.join(tmp, 'bundle.zip');
      const r = spawnSync(
        process.execPath,
        [script, '--maven', repo, '--bundle', out, '--dry-run'],
        { encoding: 'utf8', env },
      );
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const entries = Object.keys(unzipSync(fs.readFileSync(out))).sort();
      // No key in a dry run: everything but the .asc files.
      expect(entries).toEqual(
        bundlePlan(pub, fs.readdirSync(path.join(repo, pubDir))).entries.filter(
          (e) => !e.endsWith('.asc'),
        ),
      );
      expect(r.stdout).toMatch(/Dry run: .*not uploaded/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses a POM without the fields Central requires', () => {
    const { tmp, repo } = repoCopy('0.2.0');
    try {
      const r = spawnSync(process.execPath, [script, '--maven', repo, '--dry-run'], {
        encoding: 'utf8',
        env,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/no <name>/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses a release candidate', () => {
    const { tmp, repo } = repoCopy('0.2.0-rc.1');
    try {
      expect(spawnSync(process.execPath, [complete, '--maven', repo]).status).toBe(0);
      const r = spawnSync(process.execPath, [script, '--maven', repo, '--dry-run'], {
        encoding: 'utf8',
        env,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/0\.2\.0-rc\.1 is a release candidate/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
