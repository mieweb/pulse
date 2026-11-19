// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettier = require('eslint-config-prettier');

// --- Boundary rules (docs: the embed plan's §4.2, rules 1-4) ------------------------------------
// Feature, core, db and utils code (and the components and hooks they draw with) runs in both
// shells: the standalone app (src/app, on expo-router) and the embed (embed/, inside another app:
// no router, no status bar of its own, no deep links). So that code never reaches for a shell.
// src/app and src/shell/standalone are the standalone shell itself, and are exempt.
//
// Rule 4 (embed-root.tsx) is in the config below. `npm run lint` (`expo lint src embed/src`)
// checks it, and lint-zones.test.ts also lints the real embed-root.tsx with this config, so
// `npm test` holds it too.

/** Code both shells run. */
const SHARED = [
  'src/features/**',
  'src/core/**',
  'src/db/**',
  'src/utils/**',
  'src/components/**',
  'src/hooks/**',
  'src/constants/**',
];
/** The layers under the features, which never import a feature. */
const BELOW_FEATURES = ['src/core/**', 'src/db/**', 'src/utils/**'];

/**
 * Standalone-only code that still navigates with expo-router itself: allowed until onboarding
 * moves behind the standalone shell. Home's paired-destinations float pushes /destinations, the
 * pairing sheet's route.
 */
const ROUTER_ONLY = [
  'src/features/onboarding/onboarding-screen.tsx',
  'src/features/onboarding/use-onboarding-redirect.ts',
  'src/features/upload/pairing/destinations-float.tsx',
];
/**
 * Rule 2: the features the embed runs never import a standalone-only one (the plan's B6 list:
 * onboarding, About, and .pulse transfer and library backup). Home (drafts) and the screen
 * recorder are standalone screens too, but as screens: nothing imports them.
 */
const CORE_FEATURES = [
  'recorder',
  'editor',
  'export',
  'transcription',
  // Pairing too: the export screen imports its destination picker and link helpers, so the embed
  // bundles them. The pairing files below that only the Pulse app mounts lift what they need.
  'upload',
  'tips',
  'toast',
  'logs',
  'embed',
].map((f) => `./src/features/${f}`);
const STANDALONE_FEATURES = ['onboarding', 'about', 'draft-transfer'];

/**
 * The pairing files only the Pulse app mounts: the only feature code that listens for incoming
 * links, and it may navigate with expo-router. Not all of upload/pairing: the export screen, which
 * the embed runs, imports the destination picker and link helpers, and they keep every rule.
 */
const PAIRING = [
  'src/features/upload/pairing/pairing-sheet.tsx',
  'src/features/upload/pairing/upload-deep-link-provider.tsx',
];
/** The upload engine both shells run, which never imports pairing. */
const UPLOAD_CORE = './src/features/upload/core';
const UPLOAD_PAIRING = './src/features/upload/pairing';

const SHELL_ONLY = 'belongs to the standalone shell (src/app): take a callback or a port instead.';
const PACKAGES = {
  'expo-router': `expo-router ${SHELL_ONLY}`,
  'expo-status-bar': `expo-status-bar ${SHELL_ONLY} The status-bar port is @/core/status-bar.`,
  'expo-linking':
    'expo-linking is for pairing (incoming links). To open a URL or Settings, use Linking from ' +
    'react-native (openURL, openSettings).',
};
const LINK_LISTENERS = 'getInitialURL|addEventListener|useURL|useLinkingURL';
const LISTENER_MESSAGE = 'Only pairing listens for incoming links.';
const LINKING_ALIAS_MESSAGE =
  'Use Linking under its own name, so the link-listener rule can see what it is used for.';

/**
 * The no-restricted-syntax half of the boundary rules: the packages in PACKAGES that `allow`
 * doesn't lift, loaded by `require()` or `import()` (no-restricted-imports already sees
 * `import x = require()`); and, unless `allow` lifts them, link listeners on Linking, whether it's
 * imported, destructured or reached as `RN.Linking`.
 */
function syntaxRules(allow) {
  const loaded = Object.entries(PACKAGES).filter(([name]) => !allow.includes(name));
  // esquery regexes can't hold a "/": `\b(?![-.])` ends the name before a subpath or the end.
  const loads = loaded.flatMap(([name, message]) => {
    const source = `/^${name}\\b(?![-.])/`;
    return [
      `CallExpression[callee.name='require'][arguments.0.value=${source}]`,
      `ImportExpression[source.value=${source}]`,
    ].map((selector) => ({ selector, message }));
  });
  const listeners = allow.includes('link-listeners')
    ? []
    : [
        {
          selector: `MemberExpression[object.name='Linking'][property.name=/^(${LINK_LISTENERS})$/]`,
          message: LISTENER_MESSAGE,
        },
        // `import * as RN from 'react-native'; RN.Linking.getInitialURL()`
        {
          selector: `MemberExpression[object.property.name='Linking'][property.name=/^(${LINK_LISTENERS})$/]`,
          message: LISTENER_MESSAGE,
        },
        {
          selector: `ImportDeclaration[source.value='expo-linking'] > ImportSpecifier[imported.name=/^(${LINK_LISTENERS})$/]`,
          message: LISTENER_MESSAGE,
        },
        // `const { addEventListener } = Linking`
        {
          selector: `VariableDeclarator[init.name='Linking'] > ObjectPattern > Property[key.name=/^(${LINK_LISTENERS})$/]`,
          message: LISTENER_MESSAGE,
        },
        // `import { Linking as L } from 'react-native'`, which the rules above can't follow.
        {
          selector: `ImportSpecifier[imported.name='Linking'][local.name!='Linking']`,
          message: LINKING_ALIAS_MESSAGE,
        },
      ];
  const rules = [...loads, ...listeners];
  return rules.length ? ['error', ...rules] : 'off';
}

/**
 * The boundary rules for one group of files. `allow` lifts the expo-router, expo-linking,
 * link-listener or standalone-feature rule; `belowFeatures` adds "no feature imports". A later
 * group's rules replace an earlier one's for the files both match, so each group states all of its
 * rules.
 */
function boundaries({ allow = [], belowFeatures = false } = {}) {
  const zone = (from, message) => ({ target: './src', from, message });
  return {
    'no-restricted-imports': [
      'error',
      {
        patterns: Object.entries(PACKAGES)
          .filter(([name]) => !allow.includes(name))
          .map(([name, message]) => ({ regex: `^${name}(/.*)?$`, message })),
      },
    ],
    // By resolved path, so a relative import is caught as well as an `@/` one.
    'import/no-restricted-paths': [
      'error',
      {
        basePath: __dirname,
        zones: [
          zone('./src/app', 'src/app is the standalone shell: take a callback or a port instead.'),
          zone(
            './embed',
            'embed/ is the embed shell and the host package: shared code never imports it.',
          ),
          ...(belowFeatures
            ? [zone('./src/features', 'core, db and utils never import a feature.')]
            : []),
          {
            target: UPLOAD_CORE,
            from: UPLOAD_PAIRING,
            message:
              'upload/core runs in both shells and never imports upload/pairing, which is ' +
              'standalone-only: take the target from the shell (UploadStrategyContext) instead.',
          },
          ...(allow.includes('standalone-features')
            ? []
            : STANDALONE_FEATURES.map((f) => ({
                target: CORE_FEATURES,
                from: `./src/features/${f}`,
                message: `${f} is standalone-only: a feature the embed runs never imports it.`,
              }))),
        ],
      },
    ],
    // What no-restricted-imports can't see: a package loaded by require() or import(), and
    // listeners reached some other way. Opening a URL or Settings (Linking.openURL /
    // openSettings) is fine everywhere.
    'no-restricted-syntax': syntaxRules(allow),
  };
}

const boundaryConfigs = [
  { files: SHARED, rules: boundaries() },
  { files: BELOW_FEATURES, rules: boundaries({ belowFeatures: true }) },
  { files: ROUTER_ONLY, rules: boundaries({ allow: ['expo-router'] }) },
  {
    files: PAIRING,
    rules: boundaries({ allow: ['expo-router', 'expo-linking', 'link-listeners'] }),
  },
  // The destinations sheet (the /destinations route, standalone-only) shows each paired server's
  // compatibility with About's labels.
  {
    files: ['src/features/upload/pairing/destinations-sheet.tsx'],
    rules: boundaries({
      allow: ['expo-router', 'expo-linking', 'link-listeners', 'standalone-features'],
    }),
  },
  // Opens an upload's link with expo-linking's openURL; the listener rule still holds there.
  {
    files: ['src/features/upload/pairing/link-actions.ts'],
    rules: boundaries({ allow: ['expo-linking'] }),
  },
  // A round trip of the library backup through the draft-transfer feature. Tests are in neither
  // bundle.
  { files: ['src/db/persistence.test.ts'], rules: boundaries() },
  // Rule 4: the embed's entry statically imports only the storage roots, and requires the rest of
  // the runtime once the roots are set.
  {
    files: ['embed/src/embed-root.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(@/(?!utils/storage-root$)|\\.)',
              message:
                'embed-root.tsx statically imports only @/utils/storage-root: require the rest ' +
                'once the storage roots are set.',
            },
          ],
        },
      ],
      // Those require() calls are what this rule asks for.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];

module.exports = defineConfig([
  expoConfig,
  prettier,
  ...boundaryConfigs,
  {
    ignores: [
      'dist/*',
      // The same embed paths the tsconfigs exclude: the test hosts and the Capacitor/Cordova
      // plugins import @capacitor/core and cordova, which Pulse doesn't install, and `cap sync`
      // copies a web bundle into the hosts. The plugins' *.test.ts files stay linted: ESLint
      // can't re-include a file whose directory is ignored, so ignore the files (`**/*`),
      // un-ignore the directories (`**/`), then un-ignore the tests.
      'embed/hosts/**',
      'embed/packages/capacitor-pulse/**/*',
      '!embed/packages/capacitor-pulse/**/',
      '!embed/packages/capacitor-pulse/**/*.test.ts',
      'embed/packages/cordova-plugin-pulse/**/*',
      '!embed/packages/cordova-plugin-pulse/**/',
      '!embed/packages/cordova-plugin-pulse/**/*.test.ts',
      // The `**/` negations above would also re-open a plugin's own node_modules.
      'embed/packages/*/node_modules/',
      'embed/packages/*/dist/**',
      // Generated by expo prebuild / expo-brownfield.
      'embed/ios/**',
      'embed/android/**',
      'embed/artifacts/**',
    ],
  },
]);
