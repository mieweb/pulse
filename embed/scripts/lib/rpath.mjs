// The @rpath closure: every `@rpath/X.framework/X` a shipped binary loads must be a framework
// the release ships. expo-brownfield left out whisper.rn's vendored rnwhisper.xcframework, and
// PulseKit then crashed in dyld at launch; this check catches the next one at packaging time.

/**
 * The frameworks an `otool -L` listing loads through `@rpath`, without the binary's own install
 * name (the first entry of a dylib's listing), sorted. Fat binaries list once per architecture.
 * @param {string} otoolOutput
 * @param {string} [self]  The framework being listed, whose own install name is skipped.
 */
export function rpathFrameworks(otoolOutput, self) {
  const names = new Set();
  for (const line of otoolOutput.split('\n')) {
    const m = /^\s+@rpath\/([^/\s]+)\.framework\/\S+/.exec(line);
    if (m && m[1] !== self) names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * Which `@rpath` dependencies nothing in the release provides.
 * @param {Map<string, string[]>} loads  Binary label → frameworks it loads through `@rpath`.
 * @param {Iterable<string>} shipped    Framework names the release ships.
 * @returns {{ binary: string, framework: string }[]}
 */
export function missingRpathDependencies(loads, shipped) {
  const have = new Set(shipped);
  /** @type {{ binary: string, framework: string }[]} */
  const missing = [];
  for (const [binary, frameworks] of loads) {
    for (const framework of frameworks) {
      if (!have.has(framework)) missing.push({ binary, framework });
    }
  }
  return missing;
}
