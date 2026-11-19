// @ts-check
// The names of a PulseKit release's assets that more than one script needs: package-ios.mjs
// writes them, and the generators read SHA256SUMS by them.

/** The dSYMs of every packaged binary, one zip. */
export const DSYMS_ZIP = 'PulseKit-dSYMs.zip';

/**
 * Every packaged xcframework at the top level of one zip. CocoaPods takes one source per pod, so
 * cordova-plugin-pulse's PulseKit.podspec downloads this instead of the per-framework zips.
 */
export const XCFRAMEWORKS_ZIP = 'PulseKit-xcframeworks.zip';

/** The suffix of the per-xcframework zips that Package.swift declares as binary targets. */
export const XCFRAMEWORK_ZIP_SUFFIX = '.xcframework.zip';

/**
 * Checks a download base URL before it is written into Package.swift or the podspec, where a
 * quote or backslash would end the string literal.
 * @param {string} url
 */
export function assertBaseUrl(url) {
  if (!/^https:\/\/[^\s"'\\]+[^/\s"'\\]$/.test(url)) {
    throw new Error(`"${url}" is not an https URL without quotes, spaces or a trailing slash`);
  }
  return url;
}
