/**
 * Which shell runs Pulse. `standalone`: the Pulse app (expo-router). `embedded`: PulseKit inside
 * another app, where a reload would restart the host's own runtime, so recovery never reloads.
 */
export type PulseMode = 'standalone' | 'embedded';

/**
 * Why the library can't be shown.
 * - `damaged`: it failed its check and couldn't be recovered.
 * - `full`: a migration ran out of space. Freeing space and opening Pulse again fixes it.
 * - `migration`: a migration failed for another reason. The data is left as it was.
 */
export type LibraryProblem = 'damaged' | 'full' | 'migration';

/**
 * The embed's library can't be opened or migrated (B6). The flow ends `failed` with `code`:
 * `storage.full` when freeing space fixes it, else `storage.damaged`.
 */
export type FatalStorage = {
  code: 'storage.damaged' | 'storage.full';
  message: string;
};
