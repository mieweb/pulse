// @ts-check
// Whether dsymutil can make a dSYM for a binary. It reads the debug map: the OSO stabs that point
// at the object files the binary was linked from. Prebuilt release binaries (hermesvm, React,
// ReactNativeDependencies) have none, and dsymutil then prints hundreds of "unable to open object
// file" warnings and writes a dSYM with no DWARF in it. The script skips those.

/**
 * True when an `nm -ap` listing has a debug map (any OSO stab). Fat binaries list each
 * architecture; one with a debug map is enough.
 * @param {string} nmOutput
 */
export function hasDebugMap(nmOutput) {
  return /^[0-9a-f]+ - [0-9a-f]{2} [0-9a-f]{4}\s+OSO /m.test(nmOutput);
}
