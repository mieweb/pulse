/**
 * Which screen last set the shared audio session. Screens stack (the editor opens over the
 * recorder), so one leaving can finish after the next one set the session up: a screen restores
 * its own leave-time session only while it's still the last to have claimed it. expo-audio applies
 * its calls in the order they're made, so a claim made before a restore's call always wins.
 */
let owner: symbol | null = null;

/** Claim the session (before setting it up); returns the claim to check later. */
export function claimAudioSession(): symbol {
  owner = Symbol('audio-session');
  return owner;
}

/** Whether `claim` is still the last claim made. */
export const ownsAudioSession = (claim: symbol | null): boolean => claim != null && owner === claim;
