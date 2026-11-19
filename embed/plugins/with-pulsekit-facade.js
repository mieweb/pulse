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

/**
 * Adds the host-facing facade (native/ios/PulseKit*.swift, `@objc(PulseKit)`) to the PulseKit
 * framework that expo-brownfield generates, so hosts call one Pulse class and never React Native
 * directly, plus PulseKit's privacy manifest. Needs the expo-brownfield plugin's PulseKit target to
 * exist when it runs.
 */
module.exports = function withPulseKitFacade(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const target = project.pbxTargetByName(TARGET);
    const targetUuid = target && project.findTargetKey(TARGET);
    const groupKey = project.findPBXGroupKey({ name: TARGET });
    if (!targetUuid || !groupKey) {
      throw new Error(`with-pulsekit-facade: the ${TARGET} target or group isn't there yet.`);
    }
    const dir = path.join(cfg.modRequest.platformProjectRoot, TARGET);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of FILES) {
      fs.copyFileSync(path.join(__dirname, '../native/ios', name), path.join(dir, name));
      if (!project.hasFile(name)) project.addSourceFile(name, { target: targetUuid }, groupKey);
    }
    fs.copyFileSync(
      path.join(__dirname, '../native/ios', PRIVACY_MANIFEST),
      path.join(dir, PRIVACY_MANIFEST),
    );
    addResource(project, targetUuid, groupKey, PRIVACY_MANIFEST);
    addAliasFlag(project, target);
    return cfg;
  });
};
