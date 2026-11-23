// @ts-check
// The runtime dependencies expo-brownfield's fused PulseKit publication leaves out of its POM and
// Gradle module metadata (S1-b), and the rules that put them back. complete-android-metadata.mjs
// runs these over the repository the build wrote; package-android.mjs then refuses a publication
// whose POM or .module still lacks one.
//
// Why they go missing: expo-brownfield 57.0.25's fused template (plugin/templates/android/fused/
// build.gradle.kts) treats org.jetbrains.kotlinx and com.google.guava as "host platform baseline",
// so it fuses none of their classes, excludes both groups on every edge it publishes, and its
// aggregator drops guava before resolution, so neither is declared for consumers either. Spike S1's
// host then crashed on its first open (`com.google.common.base.Preconditions`, then
// `kotlinx.atomicfu.AtomicFU` from CameraX). The S1 host had to declare these five itself.

/**
 * @typedef {object} Coordinate
 * @property {string} group
 * @property {string} artifact
 * @property {string} version
 */

/**
 * The runtime dependencies every PulseKit publication must declare, with the versions spike S1's
 * build resolved (`:pulsekit:dependencies --configuration releaseRuntimeClasspath`, S1
 * logs/pulsekit-deps.txt). The release workflow takes the versions from the same report of the
 * build it packages (`--resolved`), so these defaults matter only for a local run without one.
 * @type {readonly Coordinate[]}
 */
export const BASELINE_RUNTIME_DEPENDENCIES = [
  // media3 (expo-video) and CameraX (vision-camera) call Guava at runtime.
  { group: 'com.google.guava', artifact: 'guava', version: '33.3.1-android' },
  { group: 'org.jetbrains.kotlinx', artifact: 'kotlinx-coroutines-android', version: '1.10.2' },
  { group: 'org.jetbrains.kotlinx', artifact: 'kotlinx-coroutines-guava', version: '1.10.2' },
  // CameraX's ProcessCameraProvider.
  { group: 'org.jetbrains.kotlinx', artifact: 'atomicfu', version: '0.28.0' },
  { group: 'org.jetbrains.kotlinx', artifact: 'kotlinx-serialization-core', version: '1.7.3' },
];

/** The Gradle configuration whose report gives the versions. */
export const RESOLVED_CONFIGURATION = 'releaseRuntimeClasspath';

/** @param {{ group: string, artifact: string }} c */
const key = (c) => `${c.group}:${c.artifact}`;

// --- Gradle's dependency report -----------------------------------------------------------------

/**
 * The resolved version of every module in one configuration of a `gradle dependencies` report:
 * `group:artifact:requested -> resolved`, or `group:artifact:version`, or `group:artifact ->
 * resolved` (a version from a platform). Constraint lines `(c)` and unresolved `(n)` lines don't
 * count, nor do project dependencies. ANSI colours are ignored.
 * @param {string} report
 * @param {string} [configuration]
 * @returns {Map<string, string>}  `group:artifact` → resolved version.
 */
export function parseDependencyReport(report, configuration = RESOLVED_CONFIGURATION) {
  const lines = report.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`${configuration} - `));
  if (start < 0) throw new Error(`the report has no "${configuration}" configuration`);
  /** @type {Map<string, string>} */
  const versions = new Map();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break; // the end of this configuration's tree
    const m = /^[| ]*[+\\]--- (.+)$/.exec(line);
    if (!m) continue;
    let entry = m[1].trim();
    if (/ \((c|n)\)$/.test(entry) || entry.startsWith('project ')) continue;
    entry = entry.replace(/ \(\*\)$/, '');
    const arrow = /^([^:\s]+):([^:\s]+)(?::(\{[^}]*\}|\S+))? -> (\S+)$/.exec(entry);
    const plain = /^([^:\s]+):([^:\s]+):(?:\{strictly (\S+)\}|(\S+))$/.exec(entry);
    // `a:b:+ -> c:d:1.0` is a substitution: the module on the classpath is c:d.
    const target = arrow ? /^([^:\s]+):([^:\s]+):(\S+)$/.exec(arrow[4]) : null;
    const hit = target
      ? { group: target[1], artifact: target[2], version: target[3] }
      : arrow
        ? { group: arrow[1], artifact: arrow[2], version: arrow[4] }
        : plain
          ? { group: plain[1], artifact: plain[2], version: plain[3] ?? plain[4] }
          : null;
    if (!hit) continue;
    const prev = versions.get(key(hit));
    if (prev !== undefined && prev !== hit.version) {
      throw new Error(`${key(hit)} resolves to both ${prev} and ${hit.version} in the report`);
    }
    versions.set(key(hit), hit.version);
  }
  if (versions.size === 0) throw new Error(`the "${configuration}" configuration lists nothing`);
  return versions;
}

/**
 * The baseline with the versions the build resolved. A baseline module the build doesn't resolve
 * at all is an error: the list is stale, and the S1 crash it guards against may have moved.
 * @param {Map<string, string> | null} resolved  From parseDependencyReport, or null for the
 *   defaults.
 * @param {readonly Coordinate[]} [baseline]
 * @returns {{ dependencies: Coordinate[], changed: string[] }}  `changed`: lines naming each
 *   version that differs from the default.
 */
export function resolveBaseline(resolved, baseline = BASELINE_RUNTIME_DEPENDENCIES) {
  if (resolved === null) return { dependencies: [...baseline], changed: [] };
  const missing = baseline.filter((c) => !resolved.has(key(c)));
  if (missing.length > 0) {
    throw new Error(
      `the build doesn't resolve ${missing.map(key).join(', ')}; check ` +
        'BASELINE_RUNTIME_DEPENDENCIES in embed/scripts/lib/android-metadata.mjs',
    );
  }
  /** @type {string[]} */
  const changed = [];
  const dependencies = baseline.map((c) => {
    const version = /** @type {string} */ (resolved.get(key(c)));
    if (version !== c.version) changed.push(`${key(c)}: ${c.version} -> ${version}`);
    return { ...c, version };
  });
  return { dependencies, changed };
}

// --- POM ----------------------------------------------------------------------------------------

/**
 * The span of the POM's own `<dependencies>` block (not dependencyManagement's), or null.
 * @param {string} xml
 */
function pomDependenciesSpan(xml) {
  const masked = xml
    .replace(/<!--[\s\S]*?-->/g, (s) => ' '.repeat(s.length))
    .replace(/<(dependencyManagement|profiles|build)>[\s\S]*?<\/\1>/g, (s) => ' '.repeat(s.length));
  const open = masked.indexOf('<dependencies>');
  if (open < 0) return null;
  const close = masked.indexOf('</dependencies>', open);
  if (close < 0) throw new Error('the POM has an unclosed <dependencies>');
  return { open, close };
}

/**
 * Adds runtime dependencies the POM doesn't declare yet, at the end of its `<dependencies>`
 * (making one before `</project>` if it has none), in the same form the fused template writes its
 * own injected ones. A module the POM already declares, at any version, is left alone.
 * @param {string} xml
 * @param {readonly Coordinate[]} deps
 * @returns {{ xml: string, added: string[], present: string[] }}
 */
export function addPomDependencies(xml, deps) {
  const span = pomDependenciesSpan(xml);
  const block = span ? xml.slice(span.open, span.close) : '';
  const declared = new Set(
    [...block.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].map((m) => {
      const g = /<groupId>\s*([^<]*?)\s*<\/groupId>/.exec(m[1]);
      const a = /<artifactId>\s*([^<]*?)\s*<\/artifactId>/.exec(m[1]);
      return `${g?.[1]}:${a?.[1]}`;
    }),
  );
  const toAdd = deps.filter((d) => !declared.has(key(d)));
  const present = deps.filter((d) => declared.has(key(d))).map(key);
  if (toAdd.length === 0) return { xml, added: [], present };
  const entries = toAdd
    .map(
      (d) =>
        '    <dependency>\n' +
        `      <groupId>${d.group}</groupId>\n` +
        `      <artifactId>${d.artifact}</artifactId>\n` +
        `      <version>${d.version}</version>\n` +
        '      <scope>runtime</scope>\n' +
        '    </dependency>\n',
    )
    .join('');
  let out;
  if (span) {
    // Insert before the line that closes the block, keeping that line's indent.
    const lineStart = xml.lastIndexOf('\n', span.close) + 1;
    out = xml.slice(0, lineStart) + entries + xml.slice(lineStart);
  } else {
    const end = xml.lastIndexOf('</project>');
    if (end < 0) throw new Error('the POM has no </project>');
    out = `${xml.slice(0, end)}  <dependencies>\n${entries}  </dependencies>\n${xml.slice(end)}`;
  }
  return { xml: out, added: toAdd.map(key), present };
}

// --- Gradle module metadata (.module) -----------------------------------------------------------

/**
 * @typedef {object} ModuleVariant
 * @property {string} [name]
 * @property {Record<string, unknown>} [attributes]
 * @property {{ group?: string, module?: string,
 *   version?: { requires?: string, strictly?: string, prefers?: string } }[]} [dependencies]
 */

/** @param {string} text @returns {{ variants?: ModuleVariant[] }} */
function parseModule(text) {
  const root = JSON.parse(text);
  if (!root || typeof root !== 'object' || !Array.isArray(root.variants)) {
    throw new Error('the .module file has no "variants" list');
  }
  return root;
}

/** @param {ModuleVariant} v */
const isRuntime = (v) => v.attributes?.['org.gradle.usage'] === 'java-runtime';

/**
 * Adds the dependencies to every runtime variant (`org.gradle.usage` = java-runtime; the fused
 * publication's `runtimePublication`) that doesn't declare them yet. Gradle consumers read the
 * .module before the POM, so a POM-only fix isn't one. The file is written back the way Gradle's
 * JsonOutput.prettyPrint writes it (4-space indent), and left byte-for-byte alone when nothing is
 * added.
 * @param {string} text
 * @param {readonly Coordinate[]} deps
 * @returns {{ text: string, added: string[], present: string[] }}
 */
export function addModuleDependencies(text, deps) {
  const root = parseModule(text);
  const runtime = (root.variants ?? []).filter(isRuntime);
  if (runtime.length === 0) {
    throw new Error('the .module file has no runtime variant (org.gradle.usage = java-runtime)');
  }
  /** @type {Set<string>} */
  const added = new Set();
  /** @type {Set<string>} */
  const present = new Set();
  for (const variant of runtime) {
    const list = (variant.dependencies ??= []);
    const declared = new Set(list.map((d) => `${d.group}:${d.module}`));
    for (const d of deps) {
      if (declared.has(key(d))) {
        present.add(key(d));
        continue;
      }
      list.push({ group: d.group, module: d.artifact, version: { requires: d.version } });
      added.add(key(d));
    }
  }
  if (added.size === 0) return { text, added: [], present: [...present] };
  const out = JSON.stringify(root, null, 4);
  return { text: text.endsWith('\n') ? `${out}\n` : out, added: [...added], present: [...present] };
}

/**
 * The dependencies a .module file declares, as package-android.mjs's dependency rows: scope
 * `runtime` for a java-runtime variant, `compile` for java-api; a dependency in several variants
 * is listed once per scope. The version is `strictly`, else `requires`, else `prefers`.
 * @param {string} text
 * @returns {import('./android-aar.mjs').PomDependency[]}
 */
export function moduleDependencies(text) {
  const root = parseModule(text);
  /** @type {Map<string, import('./android-aar.mjs').PomDependency>} */
  const out = new Map();
  for (const variant of root.variants ?? []) {
    const usage = variant.attributes?.['org.gradle.usage'];
    const scope = usage === 'java-api' ? 'compile' : 'runtime';
    for (const d of variant.dependencies ?? []) {
      if (!d.group || !d.module) continue;
      const version = d.version?.strictly ?? d.version?.requires ?? d.version?.prefers ?? null;
      const id = `${d.group}:${d.module}:${scope}`;
      if (!out.has(id)) {
        out.set(id, { group: d.group, artifact: d.module, version, scope, optional: false });
      }
    }
  }
  return [...out.values()];
}

/**
 * The baseline modules a list of declared dependencies lacks (by `group:artifact`; any version).
 * package-android.mjs runs it over the POM's and the .module's lists.
 * @param {readonly { group: string, artifact: string }[]} declared
 * @param {readonly { group: string, artifact: string }[]} [baseline]
 */
export function missingBaseline(declared, baseline = BASELINE_RUNTIME_DEPENDENCIES) {
  const have = new Set(declared.map(key));
  return baseline.map(key).filter((k) => !have.has(k));
}

/**
 * The .module file next to a publication's POM: `<dir>/<artifact>-<version>.module`.
 * @param {{ dir: string, artifact: string, version: string }} pub
 */
export function moduleFileOf(pub) {
  return `${pub.dir}/${pub.artifact}-${pub.version}.module`;
}
