import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import { Platform } from 'react-native';

import { getSetting, isOnboardingComplete, setSetting } from '@/db/settings';

import { uploadLog } from './upload-log';

const CHECKED_KEY = 'pairing.deferredChecked';
/** Launches a look that failed is retried on before giving up (a phone without Play, say). */
const MAX_ATTEMPTS = 3;

export type DeferredPairing =
  /** Android: the link itself, from the Play install referrer. */
  | { kind: 'link'; url: string }
  /** iOS: a URL is on the pasteboard; the person pastes it with Apple's paste button. */
  | { kind: 'pasteboard' };

/**
 * A pairing link doesn't survive a store install, so the `/pulse/open` page hands it over (#252
 * §7): on Android in the Play install referrer, on iOS on the pasteboard ("Get Pulse" copies it).
 * Looks on the first launch of a fresh install (onboarding not done yet), and not at all when that
 * launch came from a link, which already carries the pairing. Done once it has looked: a look that
 * fails (the referrer service unavailable) tries again on the next launch, up to `MAX_ATTEMPTS`.
 */
export async function checkDeferredPairing(
  launchedWithLink: boolean,
): Promise<DeferredPairing | null> {
  const state = await getSetting(CHECKED_KEY);
  if (state === 'true') return null;
  const failed = Number(/^retry:(\d+)$/.exec(state ?? '')?.[1] ?? 0);
  // An update to a build with this check, not an install: nothing was handed over. A look that
  // failed on the first launch still retries after onboarding.
  if (launchedWithLink || (failed === 0 && (await isOnboardingComplete()))) {
    await setSetting(CHECKED_KEY, 'true');
    return null;
  }
  try {
    const found = await look();
    await setSetting(CHECKED_KEY, 'true');
    return found;
  } catch (e) {
    const attempts = failed + 1;
    uploadLog.warn(`deferred pairing: look failed (${attempts}/${MAX_ATTEMPTS}): ${String(e)}`);
    await setSetting(CHECKED_KEY, attempts >= MAX_ATTEMPTS ? 'true' : `retry:${attempts}`);
    return null;
  }
}

/** What the store install handed over, or `null` for nothing; throws when it couldn't tell. */
async function look(): Promise<DeferredPairing | null> {
  if (Platform.OS === 'android') {
    const referrer = await Application.getInstallReferrerAsync();
    uploadLog.info(
      `deferred pairing: install referrer ${referrer ? `${referrer.length} chars` : 'none'}`,
    );
    // An install that didn't come from the page reports `utm_source=…`; only a pairing link has these.
    const params = new URLSearchParams(referrer ?? '');
    if (!params.get('artifactId') || !params.get('server')) return null;
    return { kind: 'link', url: `pulsecam://?${referrer}` };
  }

  if (Platform.OS === 'ios') {
    // Neither check reads the pasteboard, so neither shows the paste prompt. iOS reports the link
    // the page copies as a URL (measured on a device), so other copied text doesn't trigger this.
    const [hasUrl, hasString] = await Promise.all([
      Clipboard.hasUrlAsync(),
      Clipboard.hasStringAsync().catch(() => false), // for the log only
    ]);
    uploadLog.info(`deferred pairing: pasteboard url=${hasUrl} string=${hasString}`);
    if (hasUrl) return { kind: 'pasteboard' };
  }
  return null;
}
