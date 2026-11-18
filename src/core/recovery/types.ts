/**
 * Which shell runs Pulse. `standalone`: the Pulse app (expo-router). `embedded`: PulseKit inside
 * another app, where a reload would restart the host's own runtime, so recovery never reloads.
 */
export type PulseMode = 'standalone' | 'embedded';

/**
 * The embed's library can't be opened or migrated (B6). The flow ends `failed{storage.damaged}`;
 * with `reset`, the person asked for this account's Pulse data on this phone to be reset, which
 * the shell carries out once the runtime has let go of the library (Pulse can't reopen it here).
 */
export type FatalStorage = {
  code: 'storage.damaged';
  message: string;
  reset: boolean;
};
