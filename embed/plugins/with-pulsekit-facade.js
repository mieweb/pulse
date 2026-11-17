const fs = require('fs');
const path = require('path');
const { withXcodeProject } = require('expo/config-plugins');

const TARGET = 'PulseKit';
const FILES = ['PulseEmbed.swift'];

/**
 * Adds the host-facing facade (native/ios/PulseEmbed.swift) to the PulseKit framework that
 * expo-brownfield generates, so hosts call one Pulse class and never React Native directly.
 * Needs the expo-brownfield plugin's PulseKit target to exist when it runs.
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
    return cfg;
  });
};
