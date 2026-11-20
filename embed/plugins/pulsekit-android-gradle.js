// @ts-check
// Pure text transforms over the Android files expo-brownfield generates for the `pulsekit`
// library (embed/android/pulsekit and its fused siblings). with-pulsekit-android.js runs them on
// every prebuild. Each one is idempotent: what it adds sits between "pulsekit-android" marker
// comments and is replaced, not added again, when the transform runs twice.

const MARKER = 'pulsekit-android';
const BEGIN = `// ${MARKER}: begin`;
const END = `// ${MARKER}: end`;

// --- Defaults that depend on spike S1 (BUILD-SPEC "S1-dependent choices") -----------------------
// Flip a value here when S1 reports; nothing else needs to change.

/**
 * S1-g: what `ReactNativeHostManager.release(reason)` does. 'destroy' tears the React instance down
 * and keeps the cached host, so the next surface starts a fresh instance (code reading,
 * unverified). 'reload' restarts the instance in place, the fallback if a destroyed host won't
 * start again.
 * @type {'destroy' | 'reload'}
 */
const HOST_RELEASE = 'destroy';

/**
 * S1-a: the artifactId of the fused release publication. expo-brownfield publishes it as
 * `<libraryName>-fused-release` (S1's build: `com.mieweb.pulse:pulsekit-fused-release`); the frozen
 * coordinates are `com.mieweb.pulse:pulsekit`. null keeps expo-brownfield's name.
 * @type {string | null}
 */
const FUSED_RELEASE_ARTIFACT_ID = 'pulsekit';

/**
 * @typedef {object} Stamps
 * @property {string} version
 * @property {string} build
 * @property {string} gitSha
 * @property {number} contractMinor
 * @property {number} formatVersion
 * @property {number} dbSchema
 */

/**
 * BuildConfig fields, in the order they're written: [type, name, stamp field]. PulseKitInfo.kt
 * reads them for `info()`, as PulseKitInfo.swift reads the same stamps from Info.plist.
 * @type {readonly [string, string, keyof Stamps][]}
 */
const BUILD_CONFIG_FIELDS = [
  ['String', 'PULSEKIT_VERSION', 'version'],
  ['String', 'PULSEKIT_BUILD', 'build'],
  ['String', 'PULSEKIT_GIT_SHA', 'gitSha'],
  ['long', 'PULSEKIT_CONTRACT_MINOR', 'contractMinor'],
  ['long', 'PULSEKIT_FORMAT_VERSION', 'formatVersion'],
  ['long', 'PULSEKIT_DB_SCHEMA', 'dbSchema'],
];

/** A Kotlin string literal. */
const kt = (/** @type {string} */ s) => JSON.stringify(s).replace(/\$/g, '\\$');

/**
 * The Java literal a buildConfigField takes for one stamp.
 * @param {string} type @param {string | number} value
 */
function javaLiteral(type, value) {
  if (type === 'String') return JSON.stringify(String(value));
  if (!Number.isSafeInteger(value)) throw new Error(`${value} is not a whole number`);
  return `${value}L`;
}

/**
 * Takes out the lines an earlier run added: the BEGIN line through the END line, whole lines.
 * @param {string} text
 */
function stripBlock(text) {
  return text.replace(
    new RegExp(`^[ \\t]*${escapeRe(BEGIN)}\\n[\\s\\S]*?^[ \\t]*${escapeRe(END)}\\n`, 'gm'),
    '',
  );
}

/**
 * Wraps lines in the markers at an indent, as whole lines that stripBlock removes again.
 * @param {string} indent @param {readonly string[]} lines
 */
function block(indent, lines) {
  return `${[BEGIN, ...lines, END].map((l) => (l ? indent + l : '')).join('\n')}\n`;
}

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inserts `added` right after the first match of `anchor`, or throws naming `what`.
 * @param {string} text @param {RegExp} anchor @param {string} added @param {string} what
 */
function insertAfter(text, anchor, added, what) {
  const m = anchor.exec(text);
  if (!m)
    throw new Error(`pulsekit-android: ${what} not found; did expo-brownfield's template change?`);
  const at = m.index + m[0].length;
  return text.slice(0, at) + added + text.slice(at);
}

/**
 * Sets a Gradle script's top-level `version = "…"` (expo-brownfield writes it from app.json's
 * `android.version`).
 * @param {string} text @param {string} version
 */
function setGradleVersion(text, version) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(`pulsekit-android: "${version}" is not a Maven version`);
  }
  const re = /^version = ".*"$/m;
  if (!re.test(text)) {
    throw new Error('pulsekit-android: no `version = "…"` line; did the template change?');
  }
  return text.replace(re, `version = ${kt(version)}`);
}

/**
 * @typedef {object} LibraryOptions
 * @property {string} javaDir        embed/native/android/src/main/java, relative to the module.
 * @property {string} resDir         embed/native/android/src/main/res, relative to the module.
 * @property {string} manifest       embed/native/android/src/main/AndroidManifest.xml, relative.
 * @property {string} consumerRules  embed/native/android/consumer-rules.pro, relative.
 * @property {Stamps} stamps
 * @property {string} [version]      The Maven version to publish (PULSEKIT_VERSION), if set.
 */

/**
 * The generated android/pulsekit/build.gradle.kts, plus the facade: the Kotlin sources and
 * resources from embed/native/android, its manifest in place of expo-brownfield's empty one, its
 * consumer R8 rules, and the BuildConfig stamps.
 * @param {string} text
 * @param {LibraryOptions} opts
 */
function patchLibraryGradle(text, opts) {
  const paths = [opts.javaDir, opts.resDir, opts.manifest, opts.consumerRules];
  if (paths.some((p) => p.includes('\\'))) {
    throw new Error('pulsekit-android: Gradle paths take forward slashes');
  }
  let out = stripBlock(text);
  if (opts.version !== undefined) out = setGradleVersion(out, opts.version);
  const fields = BUILD_CONFIG_FIELDS.map(
    ([type, name, key]) =>
      `    buildConfigField(${kt(type)}, ${kt(name)}, ${kt(javaLiteral(type, opts.stamps[key]))})`,
  );
  const lines = [
    '// The PulseKit facade (embed/plugins/with-pulsekit-android.js writes this on prebuild).',
    'android {',
    '  sourceSets["main"].apply {',
    `    java.srcDir(${kt(opts.javaDir)})`,
    `    res.srcDir(${kt(opts.resDir)})`,
    `    manifest.srcFile(${kt(opts.manifest)})`,
    '  }',
    '  defaultConfig {',
    `    consumerProguardFiles(${kt(opts.consumerRules)})`,
    ...fields,
    '  }',
    '}',
  ];
  return `${out.endsWith('\n') ? out : `${out}\n`}${block('', lines)}`;
}

/**
 * The generated ReactNativeHostManager.kt, plus `release(reason)`: it destroys the React instance
 * and keeps the host. ExpoReactHostFactory caches one ReactHost for the process
 * (`if (reactHost == null)`), so a second host can't be made; the next surface start brings up a
 * fresh instance on the same host (S1-g). Fatal errors are PR4-C's: ExpoReactHostDelegate rethrows
 * unless a host handler is registered, so nothing here catches them.
 * @param {string} text
 * @param {{ mode?: 'destroy' | 'reload' }} [opts]
 */
function patchHostManager(text, opts = {}) {
  const mode = opts.mode ?? HOST_RELEASE;
  const call =
    mode === 'destroy' ? 'reactHost?.destroy(reason, null)' : 'reactHost?.reload(reason)';
  const lines = [
    '/**',
    ' * Frees the React instance (a memory warning, or PulseKit releasing Pulse) and keeps the host,',
    ' * which Expo caches for the process. The next surface starts a fresh instance on it. Added by',
    ' * embed/plugins/with-pulsekit-android.js.',
    ' */',
    'fun release(reason: String) {',
    `  ${call}`,
    '}',
  ];
  return insertAfter(
    stripBlock(text),
    /\n([ \t]*)fun getReactHost\(\): ReactHost\? \{\n[\s\S]*?\n\1\}\n/,
    block('  ', lines),
    'ReactNativeHostManager.getReactHost()',
  );
}

/**
 * A generated fused sibling's build.gradle.kts (`pulsekit-fused-release` or `-debug`): the Maven
 * version from PULSEKIT_VERSION when set, and for the release variant the frozen artifactId.
 * @param {string} text
 * @param {{ variant: 'release' | 'debug', version?: string, artifactId?: string | null }} opts
 */
function patchFusedGradle(text, opts) {
  let out = stripBlock(text);
  if (opts.version !== undefined) out = setGradleVersion(out, opts.version);
  const artifactId =
    opts.artifactId !== undefined
      ? opts.artifactId
      : opts.variant === 'release'
        ? FUSED_RELEASE_ARTIFACT_ID
        : null;
  if (artifactId === null) return out;
  return insertAfter(
    out,
    /\n([ \t]*)register<MavenPublication>\("brownfield\$\{fusedVariantCapitalized\}"\) \{\n/,
    block('        ', [`artifactId = ${kt(artifactId)}`]),
    'the fused brownfield publication',
  );
}

/**
 * The stamps for this prebuild: PULSEKIT_VERSION, PULSEKIT_BUILD and PULSEKIT_GIT_SHA when set,
 * else the app version from the source tree (plist-stamp.mjs `readSourceStamps`, the same as the
 * iOS stamps), $GITHUB_RUN_NUMBER or the commit count, and HEAD.
 * @param {{ version: string, contractMinor: number, formatVersion: number, dbSchema: number }} source
 * @param {Record<string, string | undefined>} env
 * @param {{ commitCount: () => string, head: () => string }} git
 * @returns {Stamps}
 */
function resolveStamps(source, env, git) {
  const set = (/** @type {string | undefined} */ v) =>
    v !== undefined && v !== '' ? v : undefined;
  return {
    version: set(env.PULSEKIT_VERSION) ?? source.version,
    build: set(env.PULSEKIT_BUILD) ?? set(env.GITHUB_RUN_NUMBER) ?? git.commitCount(),
    gitSha: set(env.PULSEKIT_GIT_SHA) ?? git.head(),
    contractMinor: source.contractMinor,
    formatVersion: source.formatVersion,
    dbSchema: source.dbSchema,
  };
}

module.exports = {
  MARKER,
  HOST_RELEASE,
  FUSED_RELEASE_ARTIFACT_ID,
  BUILD_CONFIG_FIELDS,
  patchLibraryGradle,
  patchHostManager,
  patchFusedGradle,
  resolveStamps,
};
