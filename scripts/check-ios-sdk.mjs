#!/usr/bin/env node
// Run locally or after prepare-expo-env: verify the selected tools, not just the runner label.
import { spawnSync } from 'node:child_process';

function output(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${reason}`);
  }
  return result.stdout.trim();
}

try {
  const xcode = output('xcodebuild', ['-version']);
  const sdk = output('xcrun', ['--sdk', 'iphoneos', '--show-sdk-version']);
  const xcodeVersion = /^Xcode (\d+(?:\.\d+){0,2})(?:\r?\n|$)/.exec(xcode)?.[1];
  const sdkVersion = /^\d+(?:\.\d+){0,2}$/.test(sdk) ? sdk : null;
  if (!xcodeVersion || !sdkVersion) {
    throw new Error(
      `Cannot verify toolchain versions: xcodebuild=${JSON.stringify(xcode)}, iPhoneOS SDK=${JSON.stringify(sdk)}`,
    );
  }
  console.log(`Selected Xcode ${xcodeVersion}; iPhoneOS SDK ${sdkVersion}.`);
  if (Number(xcodeVersion.split('.')[0]) < 27 || Number(sdkVersion.split('.')[0]) < 27) {
    throw new Error(
      'Xcode 27+ and iPhoneOS SDK 27+ are required. Check xcode_path and the selected developer directory; refusing to prebuild.',
    );
  }
  console.log('iOS SDK 27 toolchain check passed.');
} catch (error) {
  console.error(`[check-ios-sdk] ${error.message}`);
  process.exitCode = 1;
}
