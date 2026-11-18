// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettier = require('eslint-config-prettier');

// --- Boundary rules (docs: the embed plan's §4.2, rules 1, 3 and 4) -----------------------------
// Feature, core, db and utils code runs in both shells: the standalone app (src/app, on
// expo-router) and the embed (embed/, inside another app: no router, no status bar of its own, no
// deep links). So that code never reaches for a shell. src/app and src/shell/standalone are the
// standalone shell itself, and are exempt.

/** Code both shells run. */
const SHARED = ['src/features/**', 'src/core/**', 'src/db/**', 'src/utils/**'];
/** The layers under the features, which never import a feature. */
const BELOW_FEATURES = ['src/core/**', 'src/db/**', 'src/utils/**'];

/**
 * Standalone-only code that still navigates with expo-router itself: allowed until PR2-B moves
 * pairing into upload/pairing and onboarding behind the standalone shell.
 */
const ROUTER_UNTIL_PR2B = [
  'src/features/upload/destinations-sheet.tsx',
  'src/features/upload/pairing-sheet.tsx',
  'src/features/upload/upload-deep-link-provider.tsx',
  'src/features/onboarding/onboarding-screen.tsx',
  'src/features/onboarding/use-onboarding-redirect.ts',
  // Home's paired-destinations float pushes /destinations, the pairing sheet's route.
  'src/features/upload/destinations-float.tsx',
];
/** Pairing: the only feature code that listens for incoming links (until PR2-B, as above). */
const PAIRING = [
  'src/features/upload/destinations-sheet.tsx',
  'src/features/upload/pairing-sheet.tsx',
  'src/features/upload/upload-deep-link-provider.tsx',
];

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

/**
 * The boundary rules for one group of files. `allow` lifts the expo-router, expo-linking or
 * link-listener rule; `belowFeatures` adds "no feature imports". A later group's rules replace an
 * earlier one's for the files both match, so each group states all of its rules.
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
        ],
      },
    ],
    // Opening a URL or Settings (Linking.openURL / openSettings) is fine everywhere.
    'no-restricted-syntax': allow.includes('link-listeners')
      ? 'off'
      : [
          'error',
          {
            selector: `MemberExpression[object.name='Linking'][property.name=/^(${LINK_LISTENERS})$/]`,
            message: LISTENER_MESSAGE,
          },
          {
            selector: `ImportDeclaration[source.value='expo-linking'] > ImportSpecifier[imported.name=/^(${LINK_LISTENERS})$/]`,
            message: LISTENER_MESSAGE,
          },
        ],
  };
}

const boundaryConfigs = [
  { files: SHARED, rules: boundaries() },
  { files: BELOW_FEATURES, rules: boundaries({ belowFeatures: true }) },
  { files: ROUTER_UNTIL_PR2B, rules: boundaries({ allow: ['expo-router'] }) },
  {
    files: PAIRING,
    rules: boundaries({ allow: ['expo-router', 'expo-linking', 'link-listeners'] }),
  },
  // Opens an upload's link with expo-linking's openURL; the listener rule still holds there.
  {
    files: ['src/features/upload/link-actions.ts'],
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
