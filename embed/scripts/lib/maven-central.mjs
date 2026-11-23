// @ts-check
// The pure parts of publishing PulseKit's Android repository to Maven Central (O5) through the
// Central Publisher API: which files a deployment bundle holds, the POM fields Central refuses a
// deployment without, the upload and status requests, and reading the status back.
// publish-maven-central.mjs does the IO (reading the repository, gpg, fetch).
//
// API shape from https://central.sonatype.org/publish/publish-portal-api/ and the requirements
// from https://central.sonatype.org/publish/requirements/ (both read 2026-11-20). Nothing here
// has been sent to Central yet: the namespace, token and key are owner item P0.6.

import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

import { zipSync } from 'fflate';

import { stripXmlComments } from './android-aar.mjs';

/** The Central Publisher API. */
export const CENTRAL_API = 'https://central.sonatype.com/api/v1/publisher';

/**
 * USER_MANAGED: Central validates the bundle and waits for someone to press Publish in the
 * portal (the first releases). AUTOMATIC: Central publishes once it validates.
 */
export const PUBLISHING_TYPES = /** @type {const} */ (['USER_MANAGED', 'AUTOMATIC']);

/** @typedef {typeof PUBLISHING_TYPES[number]} PublishingType */

/**
 * The checksum files Central takes next to every file. md5 and sha1 are required, sha256 and
 * sha512 optional; all four are written. Signatures (.asc) get none.
 */
export const CHECKSUM_ALGORITHMS = /** @type {const} */ (['md5', 'sha1', 'sha256', 'sha512']);

/**
 * The checksum file names for one file.
 * @param {string} file
 */
export function checksumNames(file) {
  return CHECKSUM_ALGORITHMS.map((a) => `${file}.${a}`);
}

/**
 * Every checksum of some bytes, as lowercase hex (what Gradle and Maven write: the hex alone, no
 * file name and no newline).
 * @param {Uint8Array} data
 * @returns {Record<typeof CHECKSUM_ALGORITHMS[number], string>}
 */
export function checksumsOf(data) {
  const out = /** @type {Record<typeof CHECKSUM_ALGORITHMS[number], string>} */ ({});
  for (const a of CHECKSUM_ALGORITHMS) out[a] = crypto.createHash(a).update(data).digest('hex');
  return out;
}

/** A file made from another one (a checksum or a signature), which the bundle writes afresh. */
export function isDerivedFile(/** @type {string} */ name) {
  return /\.(md5|sha1|sha256|sha512|asc)$/.test(name);
}

// --- The POM fields Central requires --------------------------------------------------------

/**
 * @typedef {object} PomInfo
 * @property {string} name
 * @property {string} description
 * @property {string} url
 * @property {{ name: string, url: string }[]} licenses
 * @property {{ id: string, name: string, organization: string, organizationUrl: string }[]}
 *   developers  An organisation, not people (role "organization").
 * @property {{ connection: string, developerConnection: string, url: string }} scm
 */

/**
 * What PulseKit's POM says about the project. The license is the repository's LICENSE (MIT);
 * the developer is the GitHub organisation, never a person.
 * @type {PomInfo}
 */
export const PULSEKIT_POM_INFO = {
  name: 'PulseKit',
  description:
    'Pulse, the video capture, editing and upload app, as an Android library that a host app ' +
    'opens and talks to through the PulseKit contract.',
  url: 'https://github.com/mieweb/pulse',
  licenses: [{ name: 'MIT License', url: 'https://opensource.org/licenses/MIT' }],
  developers: [
    {
      id: 'mieweb',
      name: 'mieweb',
      organization: 'mieweb',
      organizationUrl: 'https://github.com/mieweb',
    },
  ],
  scm: {
    connection: 'scm:git:https://github.com/mieweb/pulse.git',
    developerConnection: 'scm:git:ssh://git@github.com/mieweb/pulse.git',
    url: 'https://github.com/mieweb/pulse',
  },
};

/** The project-level part of a POM: no dependencies, build, parent or profiles. */
function projectLevel(/** @type {string} */ xml) {
  return stripXmlComments(xml).replace(
    /<(dependencies|dependencyManagement|build|parent|profiles)>[\s\S]*?<\/\1>/g,
    '',
  );
}

/** @param {string} block @param {string} tag */
function text(block, tag) {
  const m = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(block);
  return m && m[1] !== '' ? m[1] : null;
}

/** @param {string} block @param {string} tag */
function section(block, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? m[1] : null;
}

/**
 * Why Central would refuse this POM: a missing name, description, url, license (name and url),
 * developer (a name or an organisation), or scm (connection, developerConnection and url); a
 * missing groupId, artifactId or version; a SNAPSHOT version.
 * @param {string} xml
 * @returns {string[]}
 */
export function centralPomProblems(xml) {
  const own = projectLevel(xml);
  /** @type {string[]} */
  const problems = [];
  for (const tag of ['groupId', 'artifactId', 'version', 'name', 'description', 'url']) {
    if (text(own, tag) === null) problems.push(`no <${tag}>`);
  }
  const version = text(own, 'version');
  if (version?.endsWith('-SNAPSHOT')) problems.push(`version ${version} is a SNAPSHOT`);

  const licenses = [
    ...(section(own, 'licenses') ?? '').matchAll(/<license>([\s\S]*?)<\/license>/g),
  ];
  if (licenses.length === 0) problems.push('no <licenses><license>');
  for (const [, l] of licenses) {
    if (text(l, 'name') === null || text(l, 'url') === null) {
      problems.push('a <license> lacks <name> or <url>');
    }
  }
  const developers = [
    ...(section(own, 'developers') ?? '').matchAll(/<developer>([\s\S]*?)<\/developer>/g),
  ];
  if (developers.length === 0) problems.push('no <developers><developer>');
  for (const [, d] of developers) {
    if (text(d, 'name') === null && text(d, 'organization') === null) {
      problems.push('a <developer> has neither <name> nor <organization>');
    }
  }
  const scm = section(own, 'scm');
  if (scm === null) problems.push('no <scm>');
  else {
    for (const tag of ['connection', 'developerConnection', 'url']) {
      if (text(scm, tag) === null) problems.push(`<scm> has no <${tag}>`);
    }
  }
  return problems;
}

/** XML text escaping for element content. */
function esc(/** @type {string} */ s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Adds the project fields Central requires that the POM lacks (expo-brownfield's fused POM has
 * none of them), right after `<packaging>` (or `<version>`), at the POM's two-space indent. A
 * field the POM already has is left as it is, so the transform is idempotent.
 * @param {string} xml
 * @param {PomInfo} [info]
 * @returns {{ xml: string, added: string[] }}
 */
export function addCentralPomInfo(xml, info = PULSEKIT_POM_INFO) {
  const own = projectLevel(xml);
  const i = '  ';
  /** @type {[string, string[]][]} */
  const fields = [
    ['name', [`<name>${esc(info.name)}</name>`]],
    ['description', [`<description>${esc(info.description)}</description>`]],
    ['url', [`<url>${esc(info.url)}</url>`]],
    [
      'licenses',
      [
        '<licenses>',
        ...info.licenses.flatMap((l) => [
          `${i}<license>`,
          `${i}${i}<name>${esc(l.name)}</name>`,
          `${i}${i}<url>${esc(l.url)}</url>`,
          `${i}</license>`,
        ]),
        '</licenses>',
      ],
    ],
    [
      'developers',
      [
        '<developers>',
        ...info.developers.flatMap((d) => [
          `${i}<developer>`,
          `${i}${i}<id>${esc(d.id)}</id>`,
          `${i}${i}<name>${esc(d.name)}</name>`,
          `${i}${i}<organization>${esc(d.organization)}</organization>`,
          `${i}${i}<organizationUrl>${esc(d.organizationUrl)}</organizationUrl>`,
          `${i}${i}<roles>`,
          `${i}${i}${i}<role>organization</role>`,
          `${i}${i}</roles>`,
          `${i}</developer>`,
        ]),
        '</developers>',
      ],
    ],
    [
      'scm',
      [
        '<scm>',
        `${i}<connection>${esc(info.scm.connection)}</connection>`,
        `${i}<developerConnection>${esc(info.scm.developerConnection)}</developerConnection>`,
        `${i}<url>${esc(info.scm.url)}</url>`,
        '</scm>',
      ],
    ],
  ];
  const missing = fields.filter(([tag]) => !new RegExp(`<${tag}>`).test(own));
  if (missing.length === 0) return { xml, added: [] };

  const anchor =
    /^([ \t]*)<packaging>[^<]*<\/packaging>[ \t]*\n/m.exec(xml) ??
    /^([ \t]*)<version>[^<]*<\/version>[ \t]*\n/m.exec(xml);
  if (!anchor) throw new Error('the POM has no <packaging> or <version> line to add fields after');
  const indent = anchor[1];
  const lines = missing.flatMap(([, l]) => l).map((l) => `${indent}${l}\n`);
  const at = anchor.index + anchor[0].length;
  return {
    xml: xml.slice(0, at) + lines.join('') + xml.slice(at),
    added: missing.map(([tag]) => tag),
  };
}

// --- The bundle ---------------------------------------------------------------------------------

/**
 * @typedef {object} BundlePlan
 * @property {string[]} files  The publication's own files that go in (relative to the
 *   repository): the AAR or JAR, the POM, the Gradle .module, and any classifier jars.
 * @property {{ path: string, kind: 'sources' | 'javadoc' }[]} placeholders  Jars Central requires
 *   that the build didn't write; the bundle carries a placeholder for each.
 * @property {string[]} entries  Every path in the bundle, sorted: each file and placeholder,
 *   its .asc and its four checksums.
 * @property {string[]} problems
 */

/**
 * What one publication's part of a Central bundle holds. `dirFiles`: the file names directly in
 * the publication's folder (`<group path>/<artifact>/<version>/`). Checksums and signatures there
 * are left out (the bundle writes its own), and so is anything that isn't
 * `<artifact>-<version>[-classifier].<ext>`.
 * @param {{ artifact: string, version: string, dir: string }} pub  From findPublications.
 * @param {readonly string[]} dirFiles
 * @returns {BundlePlan}
 */
export function bundlePlan(pub, dirFiles) {
  const base = `${pub.artifact}-${pub.version}`;
  /** @type {string[]} */
  const problems = [];
  const own = dirFiles.filter((f) => !isDerivedFile(f) && !/^maven-metadata/.test(f)).sort();
  const foreign = own.filter((f) => !f.startsWith(`${base}.`) && !f.startsWith(`${base}-`));
  if (foreign.length > 0) {
    problems.push(`${pub.dir} holds files of another artifact or version: ${foreign.join(', ')}`);
  }
  const mine = own.filter((f) => !foreign.includes(f));
  if (!mine.includes(`${base}.pom`)) problems.push(`${pub.dir} has no ${base}.pom`);
  if (!mine.includes(`${base}.aar`) && !mine.includes(`${base}.jar`)) {
    problems.push(`${pub.dir} has no ${base}.aar or ${base}.jar`);
  }
  /** @type {{ path: string, kind: 'sources' | 'javadoc' }[]} */
  const placeholders = [];
  for (const kind of /** @type {const} */ (['sources', 'javadoc'])) {
    const name = `${base}-${kind}.jar`;
    if (!mine.includes(name)) placeholders.push({ path: `${pub.dir}/${name}`, kind });
  }
  const files = mine.map((f) => `${pub.dir}/${f}`);
  const entries = [...files, ...placeholders.map((p) => p.path)]
    .flatMap((f) => [f, `${f}.asc`, ...checksumNames(f)])
    .sort();
  return { files, placeholders, entries, problems };
}

/** Jar timestamps: fixed, so a placeholder's bytes (and checksums) are the same every run. */
const JAR_MTIME = new Date(1980, 0, 1, 0, 0, 0);

/**
 * A placeholder -sources.jar or -javadoc.jar: a valid jar (a manifest) with a README pointing at
 * the repository. Central accepts placeholders for an AAR's sources and javadoc.
 * @param {'sources' | 'javadoc'} kind
 * @param {string} coordinates  `group:artifact:version`
 * @param {string} [url]
 * @returns {Uint8Array}
 */
export function placeholderJar(kind, coordinates, url = PULSEKIT_POM_INFO.url) {
  const enc = new TextEncoder();
  const readme =
    `# ${coordinates} (${kind})\n\n` +
    `This artifact ships no ${kind === 'sources' ? 'source' : 'Javadoc'} jar. The sources and ` +
    `the documentation are at ${url}.\n`;
  return zipSync({
    'META-INF/MANIFEST.MF': [enc.encode('Manifest-Version: 1.0\r\n\r\n'), { mtime: JAR_MTIME }],
    'README.md': [enc.encode(readme), { mtime: JAR_MTIME }],
  });
}

// --- Versions -----------------------------------------------------------------------------------

/**
 * Refuses a version Central must not get. Central versions can't be deleted, so release
 * candidates stay on the GitHub Release (owner answer Q-A5), and Central refuses SNAPSHOTs.
 * @param {string} version
 */
export function assertCentralVersion(version) {
  if (/-rc\.\d+$/.test(version)) {
    throw new Error(
      `${version} is a release candidate; release candidates go on the GitHub Release only`,
    );
  }
  if (version.endsWith('-SNAPSHOT')) throw new Error(`${version} is a SNAPSHOT`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${version} is not a final <major>.<minor>.<patch> version`);
  }
  return version;
}

// --- Requests -----------------------------------------------------------------------------------

/**
 * The Authorization header's value: `Bearer <base64(username:password)>`, where the username and
 * password are a Central Portal user token's two halves.
 * @param {string} username @param {string} password
 */
export function authorization(username, password) {
  if (!username || !password) throw new Error('the Central Portal user token is missing');
  return `Bearer ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * The upload request: POST /upload with the bundle as the multipart field `bundle`. No
 * Content-Type header is set, so fetch writes the multipart boundary itself.
 * @param {{ username: string, password: string, bundle: Uint8Array, fileName?: string,
 *   name: string, publishingType: PublishingType, api?: string }} opts
 * @returns {{ url: string, init: { method: 'POST', headers: Record<string, string>,
 *   body: FormData } }}
 */
export function uploadRequest(opts) {
  if (!PUBLISHING_TYPES.includes(opts.publishingType)) {
    throw new Error(`publishing type ${opts.publishingType}: not one of ${PUBLISHING_TYPES}`);
  }
  const query = new URLSearchParams({ name: opts.name, publishingType: opts.publishingType });
  const body = new FormData();
  body.append(
    'bundle',
    // A copy over a plain ArrayBuffer (Blob takes no SharedArrayBuffer view).
    new Blob([new Uint8Array(opts.bundle)], { type: 'application/octet-stream' }),
    opts.fileName ?? 'central-bundle.zip',
  );
  return {
    url: `${opts.api ?? CENTRAL_API}/upload?${query}`,
    init: {
      method: 'POST',
      headers: { Authorization: authorization(opts.username, opts.password) },
      body,
    },
  };
}

/**
 * The deployment ID from the upload's response (201, the ID as plain text).
 * @param {number} status @param {string} body
 */
export function parseUploadResponse(status, body) {
  const id = body.trim();
  if (status !== 201 && status !== 200) {
    throw new Error(`Central refused the upload (HTTP ${status}): ${id || '(no body)'}`);
  }
  if (!/^[0-9a-f-]{16,64}$/i.test(id)) {
    throw new Error(`the upload answered HTTP ${status} but no deployment ID: ${id}`);
  }
  return id;
}

/**
 * The status request: POST /status?id=<deployment>.
 * @param {{ username: string, password: string, id: string, api?: string }} opts
 */
export function statusRequest(opts) {
  return {
    url: `${opts.api ?? CENTRAL_API}/status?${new URLSearchParams({ id: opts.id })}`,
    init: {
      method: /** @type {const} */ ('POST'),
      headers: { Authorization: authorization(opts.username, opts.password) },
    },
  };
}

/**
 * @typedef {object} DeploymentStatus
 * @property {string} state  deploymentState as Central sent it.
 * @property {boolean} done  Stop polling.
 * @property {boolean} ok    Done and not failed.
 * @property {string[]} errors
 * @property {string} message  One line for the log.
 */

/**
 * Reads a status response. PENDING, VALIDATING and PUBLISHING are in progress, but for AUTOMATIC
 * PUBLISHING is the end of our part (validation passed; Central publishes on its own clock).
 * VALIDATED ends a USER_MANAGED deployment (someone presses Publish in the portal). PUBLISHED is
 * done; FAILED is done with errors. Central doesn't document the `errors` shape, so it's read as
 * a string, a list, or an object of lists (by component), flattened to lines.
 * @param {unknown} json
 * @param {PublishingType} publishingType
 * @returns {DeploymentStatus}
 */
export function parseStatus(json, publishingType) {
  const body = /** @type {{ deploymentState?: unknown, errors?: unknown }} */ (json ?? {});
  const state = typeof body.deploymentState === 'string' ? body.deploymentState : 'UNKNOWN';
  const errors = flattenErrors(body.errors);
  switch (state) {
    case 'PENDING':
    case 'VALIDATING':
      return { state, done: false, ok: false, errors, message: `${state}: validating` };
    case 'VALIDATED':
      return publishingType === 'USER_MANAGED'
        ? {
            state,
            done: true,
            ok: true,
            errors,
            message: 'VALIDATED: publish it on central.sonatype.com (Deployments)',
          }
        : { state, done: false, ok: false, errors, message: 'VALIDATED: Central publishes next' };
    case 'PUBLISHING':
      return publishingType === 'AUTOMATIC'
        ? {
            state,
            done: true,
            ok: true,
            errors,
            message: 'PUBLISHING: validated; Central is publishing it',
          }
        : { state, done: false, ok: false, errors, message: 'PUBLISHING' };
    case 'PUBLISHED':
      return { state, done: true, ok: true, errors, message: 'PUBLISHED on Maven Central' };
    case 'FAILED':
      return {
        state,
        done: true,
        ok: false,
        errors,
        message: `FAILED: ${errors.length} error(s)`,
      };
    default:
      return {
        state,
        done: true,
        ok: false,
        errors,
        message: `unexpected deploymentState ${JSON.stringify(body.deploymentState)}`,
      };
  }
}

/** @param {unknown} errors @param {string} [prefix] @returns {string[]} */
function flattenErrors(errors, prefix = '') {
  if (errors === undefined || errors === null) return [];
  if (typeof errors === 'string') return [`${prefix}${errors}`];
  if (Array.isArray(errors)) return errors.flatMap((e) => flattenErrors(e, prefix));
  if (typeof errors === 'object') {
    return Object.entries(errors).flatMap(([k, v]) => flattenErrors(v, `${prefix}${k}: `));
  }
  return [`${prefix}${String(errors)}`];
}
