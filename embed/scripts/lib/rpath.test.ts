import { describe, expect, it } from '@jest/globals';

import { missingRpathDependencies, rpathFrameworks } from './rpath.mjs';

// Trimmed from `otool -L` on a real PulseKit build (device slice) and ExpoImage (simulator).
const PULSEKIT = `/path/PulseKit.xcframework/ios-arm64/PulseKit.framework/PulseKit:
	@rpath/PulseKit.framework/PulseKit (compatibility version 0.0.0, current version 0.0.0)
	@rpath/React.framework/React (compatibility version 0.0.0, current version 0.0.0)
	@rpath/hermesvm.framework/hermesvm (compatibility version 1.0.0, current version 1.0.0)
	@rpath/rnwhisper.framework/rnwhisper (compatibility version 0.0.0, current version 1.0.0)
	/System/Library/Frameworks/Foundation.framework/Foundation (compatibility version 300.0.0, current version 4424.1.101)
	/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 2000.67.0)
	@rpath/libswiftCore.dylib (compatibility version 1.0.0, current version 6.2.0)
`;
const EXPO_IMAGE_FAT = `/path/ExpoImage (architecture x86_64):
	@rpath/ExpoImage.framework/ExpoImage (compatibility version 0.0.0, current version 0.0.0)
	@rpath/React.framework/React (compatibility version 0.0.0, current version 0.0.0)
/path/ExpoImage (architecture arm64):
	@rpath/ExpoImage.framework/ExpoImage (compatibility version 0.0.0, current version 0.0.0)
	@rpath/React.framework/React (compatibility version 0.0.0, current version 0.0.0)
	@rpath/SDWebImage.framework/SDWebImage (compatibility version 0.0.0, current version 0.0.0)
`;

describe('rpathFrameworks', () => {
  it('lists @rpath frameworks, not the binary itself, system frameworks or Swift dylibs', () => {
    expect(rpathFrameworks(PULSEKIT, 'PulseKit')).toEqual(['React', 'hermesvm', 'rnwhisper']);
  });

  it('merges a fat binary’s per-architecture listings', () => {
    expect(rpathFrameworks(EXPO_IMAGE_FAT, 'ExpoImage')).toEqual(['React', 'SDWebImage']);
  });
});

describe('missingRpathDependencies', () => {
  it('names the binary and the framework nothing ships (the rnwhisper dyld crash)', () => {
    const loads = new Map([
      ['PulseKit.xcframework/ios-arm64', rpathFrameworks(PULSEKIT, 'PulseKit')],
      ['ExpoImage.xcframework/ios-arm64', rpathFrameworks(EXPO_IMAGE_FAT, 'ExpoImage')],
    ]);
    const shipped = ['PulseKit', 'React', 'hermesvm', 'ExpoImage', 'SDWebImage'];
    expect(missingRpathDependencies(loads, shipped)).toEqual([
      { binary: 'PulseKit.xcframework/ios-arm64', framework: 'rnwhisper' },
    ]);
    expect(missingRpathDependencies(loads, [...shipped, 'rnwhisper'])).toEqual([]);
  });
});
