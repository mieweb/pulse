import { pairingLinkParams } from '@/features/upload/deep-link';
import { LINK_HOST } from '@/features/upload/link-host';

/**
 * A pairing link, in either form (`pulsecam://?…` or the https link, #252), is data, not a
 * screen: `UploadDeepLinkProvider` reads it from Linking and opens the pairing sheet over
 * whatever screen is up, so the router stays where it is. At launch, it starts on home.
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (pairingLinkParams(path, LINK_HOST) !== null) return initial ? '/' : null;
  } catch {
    // Never throw here: Expo Router crashes the app on an error from this hook.
  }
  return path;
}
