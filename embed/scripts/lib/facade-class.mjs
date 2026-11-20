// The release gate for PulseKit's facade class. Hosts find PulseKit by its Objective-C name
// (`@objc(PulseKit)`, native-bridge.md §8). A framework built without the facade's Swift sources
// still builds and packages, so every kept slice of PulseKit.xcframework must export the class.
import path from 'node:path';

/** The symbol `nm -gU` prints for the facade class (exactly this name, not PulseKitPresenter etc.). */
export const FACADE_CLASS_SYMBOL = '_OBJC_CLASS_$_PulseKit';

/**
 * The kept PulseKit slices whose binary doesn't export the facade class, as `<xcframework>/<slice id>`.
 * `inspect(cmd, args)` is the runner's: it returns the tool's output, or null in a dry run (nothing
 * to read, so nothing is reported). Other xcframeworks are ignored.
 * @param {ReadonlyArray<{ name: string, dir: string, keep: ReadonlyArray<{ id: string, binaryPath: string }> }>} jobs
 * @param {(cmd: string, args: readonly string[]) => string | null} inspect
 * @returns {string[]}
 */
export function slicesMissingFacadeClass(jobs, inspect) {
  const symbol = new RegExp(`\\s${FACADE_CLASS_SYMBOL.replace(/\$/g, '\\$')}$`, 'm');
  const missing = [];
  for (const job of jobs.filter((j) => j.name === 'PulseKit.xcframework')) {
    for (const lib of job.keep) {
      const symbols = inspect('nm', ['-gU', path.join(job.dir, lib.id, lib.binaryPath)]);
      if (symbols !== null && !symbol.test(symbols)) missing.push(`${job.name}/${lib.id}`);
    }
  }
  return missing;
}
