// @ts-check
// Pure checks over what a PulseKit Android publication holds: the AAR's entry list, its manifest
// text and its POM text (G2, G5). package-android.mjs reads those through `unzip` and hands them
// here, so every rule below runs in jest without an AAR.

import { zipSync } from 'fflate';

// --- Defaults that depend on spike S1 (BUILD-SPEC "S1-dependent choices") -----------------------
// Each default lives here once. package-android.mjs takes the ABIs and the minSdk floor from
// embed/app.json's expo-build-properties first (`buildArchs`, `minSdkVersion`), so the build and
// the check read the same values; these apply when app.json doesn't say.

/** S1-h + owner answer (2026-11-20): release AARs carry these ABIs. x86_64 is debug-only. */
export const RELEASE_ABIS = /** @type {const} */ (['arm64-v8a', 'armeabi-v7a']);
/** The debug build adds x86_64 for emulators (embed/package.json `build:android:debug`). */
export const DEBUG_ABIS = /** @type {const} */ (['arm64-v8a', 'armeabi-v7a', 'x86_64']);
/** S1-b: the highest minSdkVersion a PulseKit AAR may declare. */
export const MIN_SDK_FLOOR = 24;
/** ABIs whose libraries must be 16 KB aligned (Play's rule covers 64-bit libraries). */
export const ABIS_64 = /** @type {const} */ (['arm64-v8a', 'x86_64']);

// --- Permissions (G2; AD30 and pulse#257) ------------------------------------------------------

const P = 'android.permission.';

/**
 * What PulseKit's merged manifest may ask for. `maxSdk`: the permission must be capped at or below
 * this API level (Save to Photos needs WRITE_EXTERNAL_STORAGE on Android 7–9 only).
 * @type {readonly { name: string, maxSdk?: number }[]}
 */
export const ALLOWED_PERMISSIONS = [
  { name: `${P}CAMERA` },
  { name: `${P}RECORD_AUDIO` },
  { name: `${P}INTERNET` },
  { name: `${P}ACCESS_NETWORK_STATE` },
  { name: `${P}WAKE_LOCK` },
  { name: `${P}FOREGROUND_SERVICE` },
  { name: `${P}FOREGROUND_SERVICE_DATA_SYNC` },
  { name: `${P}VIBRATE` },
  // expo-audio's setAudioModeAsync (audio mode and speaker route); a normal permission, no prompt.
  { name: `${P}MODIFY_AUDIO_SETTINGS` },
  { name: `${P}WRITE_EXTERNAL_STORAGE`, maxSdk: 28 },
];

/**
 * What the library manifest removes with `tools:node="remove"`, so a host never inherits them
 * from a Pulse dependency. An AAR that still asks for one is refused.
 */
export const REMOVED_PERMISSIONS = /** @type {const} */ ([
  `${P}READ_MEDIA_IMAGES`,
  `${P}READ_MEDIA_VIDEO`,
  `${P}READ_MEDIA_AUDIO`,
  `${P}READ_MEDIA_VISUAL_USER_SELECTED`,
  `${P}ACCESS_MEDIA_LOCATION`,
  `${P}SYSTEM_ALERT_WINDOW`,
  `${P}FOREGROUND_SERVICE_MEDIA_PROJECTION`,
  `${P}RECEIVE_BOOT_COMPLETED`,
  // expo-file-system, expo-image, expo-image-picker and expo-media-library, up to API 32.
  `${P}READ_EXTERNAL_STORAGE`,
  // expo-application's install-referrer client (seen in spike S1's AAR).
  'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE',
]);

/** The checks package-android.mjs runs, by the name `--allow-failing` takes. */
export const CHECKS = /** @type {const} */ ([
  'abis',
  'pages',
  'minsdk',
  'permissions',
  'dependencies',
  'r8',
  'facade',
]);

/** @typedef {typeof CHECKS[number]} CheckName */

// --- embed/app.json -----------------------------------------------------------------------------

/**
 * The Android build settings embed/app.json gives expo-build-properties: the ABIs it builds
 * (`buildArchs`) and the minSdk. Missing values come back undefined.
 * @param {unknown} appJson  embed/app.json, parsed.
 * @returns {{ abis?: string[], minSdk?: number }}
 */
export function androidBuildSettings(appJson) {
  const plugins = /** @type {{ expo?: { plugins?: unknown[] } }} */ (appJson)?.expo?.plugins ?? [];
  for (const entry of plugins) {
    if (!Array.isArray(entry) || entry[0] !== 'expo-build-properties') continue;
    const android = /** @type {{ android?: { buildArchs?: unknown, minSdkVersion?: unknown } }} */ (
      entry[1]
    )?.android;
    const abis = Array.isArray(android?.buildArchs) ? android.buildArchs.map(String) : undefined;
    const minSdk = typeof android?.minSdkVersion === 'number' ? android.minSdkVersion : undefined;
    return { abis, minSdk };
  }
  return {};
}

// --- The Maven repository -----------------------------------------------------------------------

/**
 * @typedef {object} Publication
 * @property {string} group     From the path (dots).
 * @property {string} artifact
 * @property {string} version
 * @property {string} dir       `<group path>/<artifact>/<version>`, relative to the repository.
 * @property {string} pom       Relative path of the POM.
 * @property {string | null} aar  Relative path of the AAR, or null when there's none.
 */

/**
 * The publications in a Maven repository, from its file list (paths relative to the repository,
 * `/`-separated): every `<group…>/<artifact>/<version>/<artifact>-<version>.pom`. Sorted.
 * @param {readonly string[]} files
 * @returns {Publication[]}
 */
export function findPublications(files) {
  const have = new Set(files);
  /** @type {Publication[]} */
  const found = [];
  for (const file of files) {
    const parts = file.split('/');
    if (parts.length < 4) continue;
    const [artifact, version, name] = parts.slice(-3);
    if (name !== `${artifact}-${version}.pom`) continue;
    const dir = parts.slice(0, -1).join('/');
    const aar = `${dir}/${artifact}-${version}.aar`;
    found.push({
      group: parts.slice(0, -3).join('.'),
      artifact,
      version,
      dir,
      pom: file,
      aar: have.has(aar) ? aar : null,
    });
  }
  return found.sort((a, b) => cmp(a.dir, b.dir));
}

/**
 * What would make a repository a bad release: a POM without its AAR, an artifact in more than one
 * version (the zip must pin one), or a debug build mixed into it.
 * @param {readonly Publication[]} pubs
 * @returns {string[]}
 */
export function repositoryProblems(pubs) {
  /** @type {string[]} */
  const problems = [];
  if (pubs.length === 0) problems.push('no publication (no <artifact>-<version>.pom) found');
  const versions = new Map();
  for (const p of pubs) {
    const key = `${p.group}:${p.artifact}`;
    versions.set(key, [...(versions.get(key) ?? []), p.version]);
    if (p.aar === null) problems.push(`${key}:${p.version} has a POM but no AAR`);
    if (/-debug$/.test(p.artifact)) {
      problems.push(
        `${key} is a debug build; package a repository that holds a release build only`,
      );
    }
  }
  for (const [key, list] of versions) {
    if (list.length > 1) {
      problems.push(
        `${key} is there in ${list.length} versions (${list.join(', ')}); empty the repository ` +
          'and publish once',
      );
    }
  }
  return problems;
}

// --- ABIs ---------------------------------------------------------------------------------------

/**
 * The native libraries in an AAR's entry list, by ABI: `jni/<abi>/<name>.so`.
 * @param {readonly string[]} entries
 * @returns {Map<string, string[]>}  ABI → sorted library names.
 */
export function nativeLibraries(entries) {
  /** @type {Map<string, string[]>} */
  const byAbi = new Map();
  for (const entry of entries) {
    const m = /^jni\/([^/]+)\/([^/]+\.so)$/.exec(entry);
    if (!m) continue;
    byAbi.set(m[1], [...(byAbi.get(m[1]) ?? []), m[2]]);
  }
  for (const list of byAbi.values()) list.sort();
  return new Map([...byAbi].sort(([a], [b]) => cmp(a, b)));
}

/**
 * Libraries a dependency builds for one ABI only, so they're left out of the "every ABI holds the
 * same libraries" rule. whisper.rn builds a generic librnwhisper.so for every ABI (still required
 * everywhere) plus CPU-tuned variants it picks at runtime: librnwhisper_v8 and
 * librnwhisper_v8fp16_va_2 on arm64-v8a, librnwhisper_vfpv4 on armeabi-v7a, librnwhisper_x86_64 on
 * x86_64 (node_modules/whisper.rn/android/src/main/CMakeLists.txt).
 * @type {readonly RegExp[]}
 */
export const ABI_SPECIFIC_LIBRARIES = [/^librnwhisper_[\w-]+\.so$/];

/**
 * Whether the ABIs are exactly the expected ones, and each holds the same libraries (but for
 * ABI_SPECIFIC_LIBRARIES). An ABI that only some prebuilt dependencies fill (S1's AAR had 24
 * arm64-v8a libraries but 5 for x86) loads nothing on that ABI, so a partial ABI is refused too.
 * @param {Map<string, string[]>} byAbi  From nativeLibraries.
 * @param {readonly string[]} expected
 * @param {readonly RegExp[]} [abiSpecific]  Defaults to ABI_SPECIFIC_LIBRARIES.
 * @returns {string[]}
 */
export function abiProblems(byAbi, expected, abiSpecific = ABI_SPECIFIC_LIBRARIES) {
  /** @type {string[]} */
  const problems = [];
  const have = [...byAbi.keys()];
  const missing = expected.filter((abi) => !byAbi.has(abi));
  const extra = have.filter((abi) => !expected.includes(abi));
  if (missing.length > 0) problems.push(`missing ABI(s): ${missing.join(', ')}`);
  if (extra.length > 0) {
    problems.push(
      `unexpected ABI(s): ${extra.map((abi) => `${abi} (${byAbi.get(abi)?.length} libraries)`).join(', ')}`,
    );
  }
  const all = [...new Set([...byAbi.values()].flat())]
    .filter((lib) => !abiSpecific.some((re) => re.test(lib)))
    .sort();
  for (const abi of expected) {
    const libs = byAbi.get(abi);
    if (!libs) continue;
    const lacking = all.filter((lib) => !libs.includes(lib));
    if (lacking.length > 0) problems.push(`${abi} lacks ${lacking.join(', ')}`);
  }
  return problems;
}

// --- Manifest -----------------------------------------------------------------------------------

/**
 * @typedef {object} ManifestPermission
 * @property {string} name
 * @property {number | null} maxSdk  android:maxSdkVersion
 * @property {boolean} removed  tools:node="remove" (or "removeAll"): a marker, not a request.
 */

/**
 * XML without its comments, by scanning for `<!--` and `-->` (an unclosed comment runs to the end).
 * @param {string} xml
 */
export function stripXmlComments(xml) {
  let out = '';
  let i = 0;
  for (;;) {
    const start = xml.indexOf('<!--', i);
    if (start === -1) return out + xml.slice(i);
    out += xml.slice(i, start);
    const end = xml.indexOf('-->', start + 4);
    if (end === -1) return out;
    i = end + 3;
  }
}

/**
 * Reads a text AndroidManifest.xml (what an AAR carries): the minSdk and the permissions, with
 * `tools:node="remove"` markers told apart from requests. Comments are ignored, and the android
 * and tools prefixes are taken from the xmlns declarations.
 * @param {string} xml
 * @returns {{ minSdk: number | null, permissions: ManifestPermission[] }}
 */
export function parseManifest(xml) {
  const text = stripXmlComments(xml);
  const prefixOf = (/** @type {string} */ uri, /** @type {string} */ fallback) => {
    for (const m of text.matchAll(/xmlns:([\w.-]+)\s*=\s*(["'])(.*?)\2/g)) {
      if (m[3] === uri) return m[1];
    }
    return fallback;
  };
  const android = prefixOf('http://schemas.android.com/apk/res/android', 'android');
  const tools = prefixOf('http://schemas.android.com/tools', 'tools');

  /** @param {string} tag @param {string} attr */
  const attrOf = (tag, attr) => {
    for (const m of tag.matchAll(/\s([\w.:-]+)\s*=\s*(["'])(.*?)\2/g)) {
      if (m[1] === attr) return m[3];
    }
    return null;
  };

  let minSdk = null;
  const usesSdk = /<uses-sdk\b[^>]*>/.exec(text);
  if (usesSdk) {
    const value = attrOf(usesSdk[0], `${android}:minSdkVersion`);
    if (value !== null && /^\d+$/.test(value)) minSdk = Number(value);
  }

  /** @type {ManifestPermission[]} */
  const permissions = [];
  for (const m of text.matchAll(/<uses-permission(?:-sdk-23)?\b[^>]*>/g)) {
    const name = attrOf(m[0], `${android}:name`);
    if (name === null) continue;
    const max = attrOf(m[0], `${android}:maxSdkVersion`);
    const node = attrOf(m[0], `${tools}:node`);
    permissions.push({
      name,
      maxSdk: max !== null && /^\d+$/.test(max) ? Number(max) : null,
      removed: node === 'remove' || node === 'removeAll',
    });
  }
  return { minSdk, permissions };
}

/**
 * The permission check over one or more manifests (the fused AAR's, or every AAR's in a set): a
 * request is refused when it's a removed permission, isn't on the allowlist, or lacks the cap the
 * allowlist puts on it. A removal marker anywhere wins over a request (the host's merge applies it).
 * @param {readonly ManifestPermission[]} permissions
 * @param {{ allowed?: readonly { name: string, maxSdk?: number }[],
 *   removed?: readonly string[] }} [lists]
 * @returns {{ requested: { name: string, maxSdk: number | null }[], markers: string[],
 *   problems: string[] }}
 */
export function permissionCheck(permissions, lists = {}) {
  const allowed = lists.allowed ?? ALLOWED_PERMISSIONS;
  const removedList = lists.removed ?? REMOVED_PERMISSIONS;
  const markers = [...new Set(permissions.filter((p) => p.removed).map((p) => p.name))].sort();
  /** @type {Map<string, number | null>} */
  const requested = new Map();
  for (const p of permissions) {
    if (p.removed || markers.includes(p.name)) continue;
    // Two requests for one permission merge to the looser cap (none beats any number).
    const prev = requested.get(p.name);
    const cap =
      prev === undefined
        ? p.maxSdk
        : prev === null || p.maxSdk === null
          ? null
          : Math.max(prev, p.maxSdk);
    requested.set(p.name, cap);
  }
  /** @type {string[]} */
  const problems = [];
  for (const [name, maxSdk] of [...requested].sort(([a], [b]) => cmp(a, b))) {
    const rule = allowed.find((a) => a.name === name);
    if (removedList.includes(name)) {
      problems.push(`${name} is requested; PulseKit removes it (tools:node="remove")`);
    } else if (!rule) {
      problems.push(`${name} is requested and isn't on the allowlist`);
    } else if (rule.maxSdk !== undefined && (maxSdk === null || maxSdk > rule.maxSdk)) {
      problems.push(
        `${name} is requested up to ${maxSdk === null ? 'every API level' : `API ${maxSdk}`}; ` +
          `the allowlist caps it at maxSdkVersion ${rule.maxSdk}`,
      );
    }
  }
  return {
    requested: [...requested]
      .sort(([a], [b]) => cmp(a, b))
      .map(([name, maxSdk]) => ({ name, maxSdk })),
    markers,
    problems,
  };
}

// --- POM ----------------------------------------------------------------------------------------

/**
 * @typedef {object} PomDependency
 * @property {string} group
 * @property {string} artifact
 * @property {string | null} version
 * @property {string} scope  'compile' when the POM doesn't say (Maven's default).
 * @property {boolean} optional
 */

/** @param {string} block @param {string} tag */
const field = (block, tag) => {
  const m = new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`).exec(block);
  return m ? m[1] : null;
};

/**
 * A POM's own coordinates and its `<dependencies>` (not dependencyManagement's, and not the
 * artifacts named inside `<exclusions>`).
 * @param {string} xml
 * @returns {{ group: string | null, artifact: string | null, version: string | null,
 *   dependencies: PomDependency[] }}
 */
export function parsePom(xml) {
  const text = stripXmlComments(xml)
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
    .replace(/<exclusions>[\s\S]*?<\/exclusions>/g, '');
  const own = text
    .replace(/<parent>[\s\S]*?<\/parent>/g, '')
    .replace(/<dependencies>[\s\S]*?<\/dependencies>/g, '')
    .replace(/<build>[\s\S]*?<\/build>/g, '');
  const deps = /<dependencies>([\s\S]*?)<\/dependencies>/.exec(text);
  /** @type {PomDependency[]} */
  const dependencies = [];
  for (const m of (deps ? deps[1] : '').matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const group = field(m[1], 'groupId');
    const artifact = field(m[1], 'artifactId');
    if (group === null || artifact === null) continue;
    dependencies.push({
      group,
      artifact,
      version: field(m[1], 'version') || null,
      scope: field(m[1], 'scope') ?? 'compile',
      optional: field(m[1], 'optional') === 'true',
    });
  }
  return {
    group: field(own, 'groupId'),
    artifact: field(own, 'artifactId'),
    version: field(own, 'version'),
    dependencies,
  };
}

/**
 * Groups a release AAR may never depend on: React Native and Expo developer tooling.
 * @type {readonly RegExp[]}
 */
export const DENIED_DEPENDENCIES = [
  /^com\.facebook\.flipper(\.|:|$)/,
  /^host\.exp\.exponent:expo-dev-(client|launcher|menu|menu-interface)$/,
  /^expo\.modules\.dev(launcher|menu)(\.|:|$)/,
];

/**
 * Why a dependency can't be in a release POM: no version (a consumer can't resolve it), a system
 * scope (a path on the build machine), dev tooling, or one of our own artifacts that the
 * repository being shipped doesn't hold (a project name that leaked into the POM).
 * @param {PomDependency} dep
 * @param {{ ownGroup: string, shipped: ReadonlySet<string> }} context  `shipped`:
 *   `group:artifact` of every publication in the repository.
 * @returns {string | null}
 */
export function dependencyProblem(dep, { ownGroup, shipped }) {
  const coord = `${dep.group}:${dep.artifact}`;
  if (!dep.version) return `${coord} has no version`;
  if (dep.scope === 'system') return `${coord} has system scope`;
  if (DENIED_DEPENDENCIES.some((re) => re.test(coord))) return `${coord} is developer tooling`;
  if (dep.group === ownGroup && !shipped.has(coord)) {
    return `${coord} is one of ours, but the repository doesn't hold it`;
  }
  return null;
}

/**
 * The dependency matrix as Markdown: one row per dependency, sorted by coordinates.
 * @param {{ title: string, rows: readonly (PomDependency & { from: string })[] }} matrix
 */
export function formatDependencies({ title, rows }) {
  const lines = [
    `# ${title}`,
    '',
    `${rows.length} dependencies from the published POM(s).`,
    '',
    '| Group | Artifact | Version | Scope | From |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.group} | ${r.artifact} | ${r.version ?? '(none)'} | ${r.scope}${r.optional ? ' (optional)' : ''} | ${r.from} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Sorts dependency rows by group, artifact, version and source.
 * @template {PomDependency & { from: string }} T
 * @param {readonly T[]} rows
 * @returns {T[]}
 */
export function sortDependencies(rows) {
  const key = (/** @type {T} */ r) => `${r.group}\0${r.artifact}\0${r.version ?? ''}\0${r.from}`;
  return [...rows].sort((a, b) => cmp(key(a), key(b)));
}

// --- R8 rules and the facade ---------------------------------------------------------------------

/** Where an AAR carries the R8 rules its consumers apply. */
export const AAR_CONSUMER_RULES = 'proguard.txt';

/** What PulseKit's consumer rules must keep (embed/native/android/consumer-rules.pro). */
export const REQUIRED_KEEP_RULES = /** @type {const} */ ([
  'com.mieweb.pulse.kit.PulseKit',
  'expo.modules.brownfield.**',
  'com.rnwhisper.**',
]);

/**
 * Problems with an AAR's consumer R8 rules: missing (a host with minify on would strip the facade
 * and Expo's reflection-loaded modules), or without a keep rule PulseKit needs.
 * @param {string | null} rules  proguard.txt's text, or null when the AAR has none.
 * @returns {string[]}
 */
export function r8Problems(rules) {
  if (rules === null) {
    return [
      `no ${AAR_CONSUMER_RULES}: a host that minifies would strip PulseKit and Expo's modules`,
    ];
  }
  const keeps = rules
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.startsWith('-keep'));
  return REQUIRED_KEEP_RULES.filter(
    (cls) => !keeps.some((line) => line.split(/\s+/).includes(cls)),
  ).map((cls) => `${AAR_CONSUMER_RULES} has no -keep rule for ${cls}`);
}

/** Classes a host or the manifest names, which a build without the facade's sources lacks. */
export const FACADE_CLASSES = /** @type {const} */ ([
  'com/mieweb/pulse/kit/PulseKit.class',
  'com/mieweb/pulse/kit/PulseActivity.class',
  'com/mieweb/pulse/kit/PulseUploadService.class',
]);

/**
 * The facade classes classes.jar lacks (its entry list in, missing names out).
 * @param {readonly string[]} classEntries
 */
export function missingFacadeClasses(classEntries) {
  const have = new Set(classEntries);
  return FACADE_CLASSES.filter((c) => !have.has(c));
}

// --- The release zip ----------------------------------------------------------------------------

/**
 * Which repository files go into the release zip, in zip order: everything but Finder litter,
 * sorted by path so two runs list the same entries in the same order.
 * @param {readonly string[]} files  Relative, `/`-separated.
 */
export function mavenZipEntries(files) {
  return files.filter((f) => !/(^|\/)\.DS_Store$/.test(f)).sort(cmp);
}

/** Zip timestamps: fixed, so the same files give the same bytes (and the same SHA-256). */
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0);

/**
 * Zips files in the given order with fixed timestamps. AARs and JARs are already compressed, so
 * they're stored; everything else is deflated.
 * @param {readonly { name: string, data: Uint8Array }[]} files
 * @returns {Uint8Array}
 */
export function zipFiles(files) {
  /** @type {import('fflate').Zippable} */
  const tree = {};
  for (const { name, data } of files) {
    if (name in tree) throw new Error(`${name} is listed twice`);
    const stored = /\.(aar|jar|zip)$/.test(name);
    tree[name] = [data, { level: stored ? 0 : 6, mtime: ZIP_MTIME }];
  }
  return zipSync(tree);
}

/** @param {string} a @param {string} b */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
