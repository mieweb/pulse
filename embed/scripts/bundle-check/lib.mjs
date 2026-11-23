// @ts-check
// The checks behind `npm run check:embed` (the embed plan's B5 and §4.2 rules 5–7), as pure
// functions over what the CLI (scripts/check-embed-bundle.mjs) reads: the embed bundle's source
// map, the package.json files, embed/deps.json and the facade and plugin sources. Each check returns
// a list of problems, one readable line each; an empty list is a pass.

/**
 * What the embed bundle must not contain besides the packages embed/deps.json excludes (§4.1, the
 * embed shell's "must not contain"): the standalone shell and the features only the Pulse app runs.
 * Paths are repo-relative; a rule ending in "/" matches a folder, any other a single file. Each
 * reason is a sentence, as embed/deps.json's are, since problems print it after the modules found.
 * @type {readonly { path: string, reason: string }[]}
 */
export const FORBIDDEN_PATHS = [
  { path: 'src/app/', reason: 'The standalone shell (expo-router routes).' },
  { path: 'src/shell/standalone/', reason: 'The standalone shell.' },
  { path: 'src/features/onboarding/', reason: 'Onboarding is standalone-only.' },
  { path: 'src/features/about/', reason: 'About is standalone-only.' },
  {
    path: 'src/features/draft-transfer/',
    reason: '.pulse transfer and backup are standalone-only.',
  },
  { path: 'src/features/screen-capture/', reason: 'Screen recording is standalone-only.' },
  { path: 'src/features/upload/pairing/', reason: 'Pairing is standalone-only.' },
  // Pairing until PR2-B moves it into upload/pairing (eslint.config.js lists the same files).
  { path: 'src/features/upload/pairing-sheet.tsx', reason: 'Pairing is standalone-only.' },
  { path: 'src/features/upload/destinations-sheet.tsx', reason: 'Pairing is standalone-only.' },
  { path: 'src/features/upload/destinations-float.tsx', reason: 'Pairing is standalone-only.' },
  {
    path: 'src/features/upload/upload-deep-link-provider.tsx',
    reason: 'Pairing listens for incoming links; the host app owns them.',
  },
  { path: 'src/features/upload/deferred-pairing.ts', reason: 'Pairing is standalone-only.' },
  { path: 'src/features/upload/pair-link.ts', reason: 'Pairing is standalone-only.' },
  { path: 'src/features/upload/handled-links.ts', reason: 'Pairing is standalone-only.' },
];

/**
 * Packages the embed bundle must not contain that the root package.json doesn't install, so
 * embed/deps.json can't classify them (it lists only what the root package.json has).
 * @type {Readonly<Record<string, string>>}
 */
export const FORBIDDEN_EXTRA_PACKAGES = {
  'react-native-nitro-screen-recorder': 'Screen recording is standalone-only.',
};

/** Native symbols the facade and the plugins never use: only Pulse JS opens pulse.db (§4.2 rule 6). */
export const FORBIDDEN_NATIVE_SYMBOLS = ['sqlite3_open', 'SQLiteDatabase'];

/** How many offending modules a bundle problem names before it just counts the rest. */
const EXAMPLES = 3;

// --- Source map -------------------------------------------------------------------------------

/**
 * Turns a source-map `sources` entry into a repo-relative POSIX path. Metro writes sources
 * relative to the project it bundles (embed/), with a leading "/": `/src/shell/x.ts` is
 * embed/src/shell/x.ts and `/../src/db/y.ts` is src/db/y.ts. Entries that aren't files
 * (`__prelude__`, `\0polyfill:…`) come back null. A path that leaves the repo (a node_modules
 * linked from another checkout) keeps its leading `../`.
 * @param {string} source
 * @param {string} projectDir The bundled project, relative to the repo root (`embed`).
 * @returns {string | null}
 */
export function repoPath(source, projectDir) {
  if (!source.startsWith('/')) return null;
  /** @type {string[]} */
  const out = [];
  for (const part of `${projectDir}${source}`.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/**
 * Every package a module path sits in, outermost first: `node_modules/a/node_modules/@b/c/x.js`
 * is in `a` and `@b/c`.
 * @param {string} file A POSIX path.
 */
export function packagesOf(file) {
  /** @type {string[]} */
  const names = [];
  const parts = file.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] !== 'node_modules') continue;
    const first = parts[i + 1];
    if (first.startsWith('@')) {
      if (i + 2 < parts.length) names.push(`${first}/${parts[i + 2]}`);
    } else {
      names.push(first);
    }
  }
  return names;
}

/**
 * Rule 5: the bundle's modules against the "must not contain" list. A module is forbidden when it
 * sits in a forbidden package (at any depth: a dependency that only a forbidden package pulls in
 * names it) or, outside node_modules, under a forbidden path.
 * @param {{ sources?: unknown }} sourceMap A parsed Metro source map.
 * @param {{ projectDir: string, packages: Readonly<Record<string, string>>,
 *   paths?: readonly { path: string, reason: string }[] }} rules
 *   `packages` maps a package name to why the embed leaves it out.
 */
export function bundleProblems(sourceMap, { projectDir, packages, paths = FORBIDDEN_PATHS }) {
  if (!Array.isArray(sourceMap.sources) || sourceMap.sources.length === 0) {
    return ['the source map lists no sources: was it written by `expo export:embed`?'];
  }
  /** @type {Map<string, { reason: string, files: string[] }>} */
  const hits = new Map();
  const hit = (
    /** @type {string} */ rule,
    /** @type {string} */ reason,
    /** @type {string} */ f,
  ) => {
    const entry = hits.get(rule) ?? { reason, files: [] };
    entry.files.push(f);
    hits.set(rule, entry);
  };
  for (const source of sourceMap.sources) {
    if (typeof source !== 'string') continue;
    const file = repoPath(source, projectDir);
    if (file === null) continue;
    const inPackages = packagesOf(file);
    for (const name of inPackages) {
      if (Object.hasOwn(packages, name)) hit(name, packages[name], file);
    }
    if (inPackages.length) continue;
    for (const rule of paths) {
      const match = rule.path.endsWith('/') ? file.startsWith(rule.path) : file === rule.path;
      if (match) hit(rule.path, rule.reason, file);
    }
  }
  return [...hits].map(([rule, { reason, files }]) => {
    const more = files.length > EXAMPLES ? `, and ${files.length - EXAMPLES} more` : '';
    const n = files.length === 1 ? '1 module' : `${files.length} modules`;
    return `${rule}: ${n} in the bundle (${files.slice(0, EXAMPLES).join(', ')}${more}). ${reason}`;
  });
}

// --- Dependency classification (rule 7) -------------------------------------------------------

/**
 * @typedef {object} DepsFile embed/deps.json
 * @property {Record<string, string>} included Native packages PulseKit links, each with why.
 * @property {Record<string, string>} excluded Native packages it leaves out, each with why.
 */

/** Top-level entries that mark a package as having native code (or an Expo native module). */
const NATIVE_MARKERS =
  /^(ios|android|apple|cpp|expo-module\.config\.json|react-native\.config\.js|.+\.podspec)$/;

/**
 * Whether a package ships native code, from the names at the top of its folder.
 * @param {readonly string[]} entries
 */
export function isNativePackage(entries) {
  return entries.some((e) => NATIVE_MARKERS.test(e));
}

/**
 * Reads embed/deps.json's shape: two objects of package name → a non-empty reason.
 * @param {unknown} raw
 * @returns {{ deps: DepsFile | null, problems: string[] }}
 */
export function parseDeps(raw) {
  /** @type {string[]} */
  const problems = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { deps: null, problems: ['embed/deps.json is not a JSON object'] };
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);
  /** @param {'included' | 'excluded'} key */
  const section = (key) => {
    const value = obj[key];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      problems.push(`embed/deps.json has no "${key}" object`);
      return {};
    }
    /** @type {Record<string, string>} */
    const out = {};
    for (const [name, reason] of Object.entries(value)) {
      if (typeof reason !== 'string' || reason.trim() === '') {
        problems.push(`embed/deps.json: ${key} "${name}" needs a one-line reason`);
      } else {
        out[name] = reason;
      }
    }
    return out;
  };
  const deps = { included: section('included'), excluded: section('excluded') };
  for (const key of Object.keys(obj)) {
    if (!['$comment', 'included', 'excluded'].includes(key)) {
      problems.push(`embed/deps.json: unknown key "${key}"`);
    }
  }
  return { deps: problems.length ? null : deps, problems };
}

/** @param {unknown} pkg @returns {string[]} */
function depNames(pkg) {
  const p = /** @type {{ dependencies?: object, devDependencies?: object } | null} */ (pkg);
  return [...Object.keys(p?.dependencies ?? {}), ...Object.keys(p?.devDependencies ?? {})];
}

/**
 * Rule 7: every native package the root package.json installs is classified, and the
 * classification agrees with embed/package.json, which is what PulseKit's autolinking links.
 * @param {{ rootPackage: unknown, embedPackage: unknown, deps: DepsFile,
 *   isNative: (name: string) => boolean }} input
 */
export function classificationProblems({ rootPackage, embedPackage, deps, isNative }) {
  /** @type {string[]} */
  const problems = [];
  const root = new Set(depNames(rootPackage));
  const embed = new Set(depNames(embedPackage));
  const { included, excluded } = deps;
  const has = (/** @type {object} */ o, /** @type {string} */ k) => Object.hasOwn(o, k);

  for (const name of Object.keys(included)) {
    if (has(excluded, name))
      problems.push(`${name} is both included and excluded in embed/deps.json`);
  }
  for (const name of [...Object.keys(included), ...Object.keys(excluded)]) {
    if (!root.has(name)) {
      problems.push(`embed/deps.json classifies ${name}, which the root package.json doesn't list`);
    }
  }
  for (const name of [...root].sort()) {
    if (!has(included, name) && !has(excluded, name) && isNative(name)) {
      problems.push(
        `${name} is a native dependency of the root package.json but embed/deps.json doesn't ` +
          'classify it: add it to "included" or "excluded" with a one-line reason',
      );
    }
  }
  for (const name of Object.keys(included)) {
    if (!embed.has(name)) {
      problems.push(
        `${name} is included in embed/deps.json but embed/package.json doesn't list it, so ` +
          "PulseKit wouldn't link it",
      );
    }
  }
  for (const name of [...embed].sort()) {
    if (has(excluded, name)) {
      problems.push(`${name} is excluded in embed/deps.json but embed/package.json links it`);
    } else if (!has(included, name) && root.has(name) && isNative(name)) {
      problems.push(`embed/package.json links ${name}, which embed/deps.json doesn't include`);
    } else if (!root.has(name)) {
      problems.push(
        `embed/package.json lists ${name}, which the root package.json doesn't install ` +
          '(the embed builds from the root node_modules)',
      );
    }
  }
  return problems;
}

/**
 * The packages the bundle check forbids: everything embed/deps.json excludes, plus the extras.
 * @param {DepsFile} deps
 * @returns {Record<string, string>}
 */
export function forbiddenPackages(deps) {
  return { ...deps.excluded, ...FORBIDDEN_EXTRA_PACKAGES };
}

// --- Native sources ---------------------------------------------------------------------------

/**
 * @typedef {object} SourceFile
 * @property {string} path Repo-relative.
 * @property {string} text
 */

/**
 * Rule 6: the facade and the plugins never open SQLite themselves.
 * @param {readonly SourceFile[]} files
 */
export function nativeSymbolProblems(files) {
  /** @type {string[]} */
  const problems = [];
  for (const { path, text } of files) {
    text.split('\n').forEach((line, i) => {
      for (const symbol of FORBIDDEN_NATIVE_SYMBOLS) {
        if (line.includes(symbol)) {
          problems.push(
            `${path}:${i + 1} uses ${symbol}: only Pulse JS opens pulse.db (§4.2 rule 6)`,
          );
        }
      }
    });
  }
  return problems;
}

/**
 * Swift source without its comments, so a declaration only counts when it's code. Block comments
 * are replaced by a space; string literals are left alone (none of the patterns below hold one).
 * @param {string} text
 */
export function stripSwiftComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}

/**
 * The Objective-C names hosts call PulseKit by, at run time and without a compile-time
 * dependency (TimeHuddle's AppDelegate: `NSClassFromString("PulseKit")`, `shared`, then
 * `handleEventsForBackgroundURLSession:completionHandler:` with a BOOL return). Renaming any of
 * them compiles fine and silently drops background upload events, so the check holds them.
 */
const FACADE_DECLARATIONS = [
  {
    what: 'the class PulseKit under its Objective-C name `PulseKit`',
    re: /@objc\(PulseKit\)\s*(?:public\s+|open\s+)?(?:final\s+)?class\s+PulseKit\b/,
  },
  {
    what: '`@objc public static let shared`',
    re: /@objc\s+public\s+static\s+(?:let|var)\s+shared\b/,
  },
  {
    what:
      '`handleEventsForBackgroundURLSession:completionHandler:` (identifier: String, ' +
      'completionHandler: @escaping () -> Void) -> Bool',
    re: new RegExp(
      [
        '@objc(?:\\(handleEventsForBackgroundURLSession:completionHandler:\\))?\\s*',
        '(?:public\\s+|open\\s+)?func\\s+handleEventsForBackgroundURLSession\\s*\\(\\s*',
        '_\\s+\\w+\\s*:\\s*String\\s*,\\s*',
        'completionHandler\\s*:\\s*@escaping\\s*\\(\\s*\\)\\s*->\\s*(?:Void|\\(\\s*\\))\\s*\\)\\s*',
        '->\\s*Bool\\b',
      ].join(''),
    ),
  },
];

/**
 * Checks that the facade still declares what hosts call by selector.
 * @param {readonly SourceFile[]} swiftFiles The facade's Swift sources (embed/native/ios).
 */
export function facadeProblems(swiftFiles) {
  const code = swiftFiles.map((f) => stripSwiftComments(f.text)).join('\n');
  return FACADE_DECLARATIONS.filter(({ re }) => !re.test(code)).map(
    ({ what }) =>
      `embed/native/ios no longer declares ${what}: hosts call it by name (PR3's AppDelegate), ` +
      'so a rename breaks them without a compile error',
  );
}
