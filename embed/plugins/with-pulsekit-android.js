const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { withFinalizedMod } = require('expo/config-plugins');

const {
  patchFusedGradle,
  patchHostManager,
  patchLibraryGradle,
  resolveStamps,
} = require('./pulsekit-android-gradle');

// expo-brownfield's library (app.json `android.libraryName`) and its package path.
const LIBRARY = 'pulsekit';
const PACKAGE_PATH = 'com/mieweb/pulse/kit';
// The facade's Android sources, resources, manifest and consumer R8 rules.
const NATIVE = path.join(__dirname, '../native/android');
const REPO_ROOT = path.join(__dirname, '../..');

/** A path relative to `from`, with forward slashes (Gradle's Kotlin DSL takes them on Windows too). */
const gradlePath = (from, to) => path.relative(from, to).split(path.sep).join('/');

/** @param {string} file @param {(text: string) => string} transform */
function rewrite(file, transform) {
  if (!fs.existsSync(file)) {
    throw new Error(`with-pulsekit-android: ${file} isn't there; is expo-brownfield registered?`);
  }
  const before = fs.readFileSync(file, 'utf8');
  const after = transform(before);
  if (after !== before) fs.writeFileSync(file, after);
}

/** @param {readonly string[]} args */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      `with-pulsekit-android: \`git ${args.join(' ')}\` failed; outside a git checkout, set ` +
        'PULSEKIT_BUILD and PULSEKIT_GIT_SHA.',
    );
  }
}

/**
 * The BuildConfig stamps for this prebuild (pulsekit-android-gradle.js `resolveStamps`), from the
 * same sources as the iOS Info.plist stamps (embed/scripts/lib/plist-stamp.mjs) and checked the
 * same way. plist-stamp.mjs is an ES module without top-level await, which Node's `require`
 * loads (Node >= 20.19; Pulse needs 24).
 */
function readStamps() {
  const { readSourceStamps, validateStamps } = require('../scripts/lib/plist-stamp.mjs');
  const stamps = resolveStamps(readSourceStamps(REPO_ROOT), process.env, {
    commitCount: () => git(['rev-list', '--count', 'HEAD']),
    head: () => git(['rev-parse', 'HEAD']),
  });
  return validateStamps(stamps);
}

/**
 * The release ABIs: expo-build-properties' android `buildArchs` in embed/app.json (the owner's
 * answer, 2026-11-20: arm64-v8a and armeabi-v7a). package-android.mjs checks against the same
 * list. Refuses a config without it, so a release AAR never ships every ABI by accident.
 * @param {{ plugins?: unknown[] }} cfg
 * @returns {string[]}
 */
function buildArchs(cfg) {
  for (const entry of cfg.plugins ?? []) {
    if (!Array.isArray(entry) || entry[0] !== 'expo-build-properties') continue;
    const archs = entry[1]?.android?.buildArchs;
    if (Array.isArray(archs) && archs.length > 0) return archs.map(String);
  }
  throw new Error(
    "with-pulsekit-android: embed/app.json's expo-build-properties has no android.buildArchs; " +
      'the release AAR ships only those ABIs',
  );
}

/**
 * Adds the Android facade (embed/native/android) to the `pulsekit` library expo-brownfield
 * generates: its Kotlin sources and resources, its manifest and consumer R8 rules, the BuildConfig
 * stamps, `ReactNativeHostManager.release(reason)`, and the frozen Maven coordinates
 * (`com.mieweb.pulse:pulsekit` at the stamped version: PULSEKIT_VERSION, else the app version).
 * The fused AARs also get the consumer R8 rules AGP doesn't bundle, and the release one only the
 * `buildArchs` ABIs (pulsekit-android-gradle.js `patchFusedGradle`).
 *
 * A finalized mod: expo-brownfield writes (and on every prebuild rewrites) the module's files from
 * its templates inside its AndroidManifest mod, and dangerous mods run before every other mod, so
 * a dangerous mod would find the files missing on a clean prebuild. The transforms are idempotent,
 * so a second prebuild leaves the module as the first left it.
 */
module.exports = function withPulseKitAndroid(config) {
  return withFinalizedMod(config, [
    'android',
    (cfg) => {
      const androidRoot = cfg.modRequest.platformProjectRoot;
      const moduleDir = path.join(androidRoot, LIBRARY);
      const stamps = readStamps();
      // One version (AD18): the Maven coordinates carry the version BuildConfig and info() report.
      const version = stamps.version;
      const releaseAbis = buildArchs(cfg);
      for (const file of ['src/main/AndroidManifest.xml', 'consumer-rules.pro']) {
        if (!fs.existsSync(path.join(NATIVE, file))) {
          throw new Error(`with-pulsekit-android: ${path.join(NATIVE, file)} is missing`);
        }
      }

      rewrite(path.join(moduleDir, 'build.gradle.kts'), (text) =>
        patchLibraryGradle(text, {
          javaDir: gradlePath(moduleDir, path.join(NATIVE, 'src/main/java')),
          resDir: gradlePath(moduleDir, path.join(NATIVE, 'src/main/res')),
          manifest: gradlePath(moduleDir, path.join(NATIVE, 'src/main/AndroidManifest.xml')),
          consumerRules: gradlePath(moduleDir, path.join(NATIVE, 'consumer-rules.pro')),
          stamps,
          version,
        }),
      );
      rewrite(
        path.join(moduleDir, 'src/main/java', PACKAGE_PATH, 'ReactNativeHostManager.kt'),
        (text) => patchHostManager(text),
      );
      for (const variant of /** @type {const} */ (['release', 'debug'])) {
        rewrite(path.join(androidRoot, `${LIBRARY}-fused-${variant}`, 'build.gradle.kts'), (text) =>
          patchFusedGradle(text, {
            variant,
            version,
            // Debug keeps every ABI: `build:android:debug` adds x86_64 for emulators.
            abis: variant === 'release' ? releaseAbis : undefined,
          }),
        );
      }
      return cfg;
    },
  ]);
};
