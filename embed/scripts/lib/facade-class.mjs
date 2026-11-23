// The release gate for PulseKit's facade class. Hosts find PulseKit by its Objective-C name
// (`@objc(PulseKit)`, native-bridge.md §8). A framework built without the facade's Swift sources
// still builds and packages, so every kept slice of PulseKit.xcframework must export the class.
import path from 'node:path';

/** The symbol `nm -gU` prints for the facade class (exactly this name, not PulseKitPresenter etc.). */
export const FACADE_CLASS_SYMBOL = '_OBJC_CLASS_$_PulseKit';

/**
 * The kept PulseKit slices whose binary doesn't export the facade class, as `<xcframework>/<slice id>`
 * (with ` (<arch>)` for one architecture of a universal slice). A slice listing more than one
 * architecture (a simulator's arm64 + x86_64) is read once per architecture, so a binary where only
 * one of them has the class doesn't pass. `inspect(cmd, args)` is the runner's: it returns the
 * tool's output, or null in a dry run (nothing to read, so nothing is reported). Other
 * xcframeworks are ignored.
 * @param {ReadonlyArray<{ name: string, dir: string, keep: ReadonlyArray<{ id: string, binaryPath: string, archs?: readonly string[] }> }>} jobs
 * @param {(cmd: string, args: readonly string[]) => string | null} inspect
 * @returns {string[]}
 */
export function slicesMissingFacadeClass(jobs, inspect) {
  const missing = [];
  for (const job of jobs.filter((j) => j.name === 'PulseKit.xcframework')) {
    for (const lib of job.keep) {
      const binary = path.join(job.dir, lib.id, lib.binaryPath);
      const archs = lib.archs ?? [];
      if (archs.length < 2) {
        const symbols = inspect('nm', ['-gU', binary]);
        if (symbols !== null && !exportsFacadeClass(symbols)) missing.push(`${job.name}/${lib.id}`);
        continue;
      }
      for (const arch of archs) {
        const symbols = inspect('nm', ['-arch', arch, '-gU', binary]);
        if (symbols !== null && !exportsFacadeClass(symbols)) {
          missing.push(`${job.name}/${lib.id} (${arch})`);
        }
      }
    }
  }
  return missing;
}

/** Whether `nm -gU` output has a line whose symbol (its last field) is exactly the facade class. */
function exportsFacadeClass(nmOutput) {
  return nmOutput
    .split('\n')
    .some((line) => line.trim().split(/\s+/).pop() === FACADE_CLASS_SYMBOL);
}
