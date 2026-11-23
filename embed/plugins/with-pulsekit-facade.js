const fs = require('fs');
const path = require('path');
const { withXcodeProject } = require('expo/config-plugins');

const TARGET = 'PulseKit';
// The facade (native-bridge.md §8). Only these files: native/ios/tests and native/ios/vectors
// are macOS-run checks, never part of the framework.
const FILES = [
  'PulseKit.swift',
  'PulseKitEnvelope.swift',
  'PulseKitInfo.swift',
  'PulseKitInbox.swift',
  'PulseKitPresenter.swift',
  'PulseKitBackground.swift',
  'PulseKitAccounts.swift',
  'PulseKitCatalog.swift',
  'PulseKitStorage.swift',
];

// PulseKit's privacy manifest (K2), a resource at the framework's root, where Apple's privacy
// report reads it. package-ios.mjs writes the same file into the packaged framework too.
const PRIVACY_MANIFEST = 'PrivacyInfo.xcprivacy';

// The facade's class is named like its module (`PulseKit.PulseKit`, native-bridge.md §8). The
// target builds with BUILD_LIBRARY_FOR_DISTRIBUTION, so Swift writes a .swiftinterface, and there
// every module-qualified name (`PulseKit.JSONValue`) would resolve against the class instead of
// the module: Xcode's interface verification fails, and so would a host on another compiler
// (swift#56573). This flag makes the interface name the module by an alias that can't clash.
const ALIAS_FLAG = '-Xfrontend -alias-module-names-in-module-interface';

/** Appends ALIAS_FLAG to OTHER_SWIFT_FLAGS in each of the target's build configurations. */
function addAliasFlag(project, target) {
  const lists = project.pbxXCConfigurationList();
  const configs = project.pbxXCBuildConfigurationSection();
  const list = lists[target.buildConfigurationList];
  if (!list || !list.buildConfigurations) {
    throw new Error(`with-pulsekit-facade: the ${TARGET} target has no build configurations.`);
  }
  for (const { value } of list.buildConfigurations) {
    const settings = configs[value] && configs[value].buildSettings;
    if (!settings) continue;
    const current = String(settings.OTHER_SWIFT_FLAGS || '$(inherited)').replace(/^"|"$/g, '');
    if (current.includes(ALIAS_FLAG)) continue;
    settings.OTHER_SWIFT_FLAGS = `"${current} ${ALIAS_FLAG}"`;
  }
}

// The facade builds with the `headless` capability on (PulseKitInfo.swift; spike S3 passed on an
// iPhone 2026-11-20): host writes boot Pulse with no screen instead of "Preparing…".
// `PULSEKIT_HEADLESS=0 npm run prebuild` builds it off.
const HEADLESS_CONDITION = 'PULSEKIT_HEADLESS';

/** Adds or removes HEADLESS_CONDITION in each configuration's SWIFT_ACTIVE_COMPILATION_CONDITIONS. */
function setHeadless(project, target, on) {
  const lists = project.pbxXCConfigurationList();
  const configs = project.pbxXCBuildConfigurationSection();
  const list = lists[target.buildConfigurationList];
  for (const { value } of (list && list.buildConfigurations) || []) {
    const settings = configs[value] && configs[value].buildSettings;
    if (!settings) continue;
    const current = String(settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS || '$(inherited)')
      .replace(/^"|"$/g, '')
      .split(/\s+/)
      .filter((c) => c && c !== HEADLESS_CONDITION);
    if (on) current.push(HEADLESS_CONDITION);
    settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS = `"${current.join(' ')}"`;
  }
}

/**
 * Adds `name` (already copied into the target's folder) to the target's Copy Bundle Resources.
 * The host app has a PrivacyInfo.xcprivacy of its own, so this looks in the PulseKit group only.
 */
function addResource(project, targetUuid, groupKey, name) {
  const group = project.getPBXGroupByKey(groupKey);
  if (group && (group.children || []).some((child) => child.comment === name)) return;
  if (!project.pbxResourcesBuildPhaseObj(targetUuid)) {
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', targetUuid);
  }
  // The xcode library doesn't know .xcprivacy; Xcode files it as XML (UTF-8).
  project.addResourceFile(
    name,
    { target: targetUuid, lastKnownFileType: 'text.xml', defaultEncoding: 4 },
    groupKey,
  );
}

/** The Sources build phase of the target with this uuid, or undefined. */
function sourcesPhaseOf(project, targetUuid) {
  const objects = project.hash.project.objects;
  const target = (objects.PBXNativeTarget || {})[targetUuid];
  const phase = (target?.buildPhases || []).find((p) => objects.PBXSourcesBuildPhase?.[p.value]);
  return phase && objects.PBXSourcesBuildPhase[phase.value];
}

/**
 * Puts `name`'s build file in the PulseKit target's Sources phase and takes it out of every other
 * target's. addSourceFile's `target` option finds the phase by its "Sources" comment, which
 * expo-brownfield's target doesn't have, so the xcode library files the source under the first
 * target, the Pulse app. A `-scheme PulseKit` build then never compiles the facade, and the
 * framework ships without its `PulseKit` class (pulsekit-v0.1.0-rc.4).
 */
function compileInPulseKit(project, targetUuid, name) {
  const kit = sourcesPhaseOf(project, targetUuid);
  if (!kit) throw new Error(`with-pulsekit-facade: the ${TARGET} target has no Sources phase.`);
  const comment = `${name} in Sources`;
  const phases = Object.entries(project.hash.project.objects.PBXSourcesBuildPhase || {}).filter(
    ([key]) => !key.endsWith('_comment'),
  );
  let file;
  for (const [, phase] of phases) {
    if (phase === kit) continue;
    const found = (phase.files || []).filter((f) => f.comment === comment);
    if (found.length) {
      file = file ?? found[0];
      phase.files = phase.files.filter((f) => f.comment !== comment);
    }
  }
  kit.files = kit.files || [];
  if (file && !kit.files.some((f) => f.comment === comment)) kit.files.push(file);
  if (!kit.files.some((f) => f.comment === comment)) {
    throw new Error(`with-pulsekit-facade: ${name} isn't in the ${TARGET} target's sources.`);
  }
}

/** A pbxproj name without the quotes the xcode library may keep around it (`"PulseKit"`). */
const unquote = (value) => String(value ?? '').replace(/^"(.*)"$/, '$1');

/**
 * expo-brownfield's PulseKit target and group. It adds both with quoted names, so the xcode
 * library's exact-name lookups (pbxTargetByName, findPBXGroupKey) don't find them on a clean
 * prebuild.
 */
function findPulseKit(project) {
  const entries = (section) =>
    Object.entries(section || {}).filter(([key]) => !key.endsWith('_comment'));
  const [targetUuid, target] =
    entries(project.pbxNativeTargetSection()).find(([, t]) => unquote(t.name) === TARGET) ?? [];
  const [groupKey] =
    entries(project.hash.project.objects.PBXGroup).find(
      ([, g]) => unquote(g.name) === TARGET || (!g.name && unquote(g.path) === TARGET),
    ) ?? [];
  return { targetUuid, target, groupKey };
}

/**
 * Adds the host-facing facade (native/ios/PulseKit*.swift, `@objc(PulseKit)`) to the PulseKit
 * framework that expo-brownfield generates, so hosts call one Pulse class and never React Native
 * directly, plus PulseKit's privacy manifest. Needs the expo-brownfield plugin's PulseKit target to
 * exist when it runs.
 */
module.exports = function withPulseKitFacade(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const { targetUuid, target, groupKey } = findPulseKit(project);
    if (!targetUuid || !groupKey) {
      throw new Error(`with-pulsekit-facade: the ${TARGET} target or group isn't there yet.`);
    }
    const dir = path.join(cfg.modRequest.platformProjectRoot, TARGET);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of FILES) {
      fs.copyFileSync(path.join(__dirname, '../native/ios', name), path.join(dir, name));
      if (!project.hasFile(name)) project.addSourceFile(name, { target: targetUuid }, groupKey);
      compileInPulseKit(project, targetUuid, name);
    }
    fs.copyFileSync(
      path.join(__dirname, '../native/ios', PRIVACY_MANIFEST),
      path.join(dir, PRIVACY_MANIFEST),
    );
    addResource(project, targetUuid, groupKey, PRIVACY_MANIFEST);
    addAliasFlag(project, target);
    setHeadless(project, target, process.env.PULSEKIT_HEADLESS !== '0');
    return cfg;
  });
};
