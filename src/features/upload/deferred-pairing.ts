import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import { Platform } from 'react-native';

import { getSetting, isOnboardingComplete, setSetting } from '@/db/settings';

import { uploadLog } from './upload-log';

const CHECKED_KEY = 'pairing.deferredChecked';

export type DeferredPairing =
  /** Android: the link itself, from the Play install referrer. */
  | { kind: 'link'; url: string }
  /** iOS: a URL is on the pasteboard; the person pastes it with Apple's paste button. */
  | { kind: 'pasteboard' };

/**
 * A pairing link doesn't survive a store install, so the `/pulse/open` page hands it over (#252
 * §7): on Android in the Play install referrer, on iOS on the pasteboard ("Get Pulse" copies it).
 * Looks once per install, on the first launch of a fresh install (onboarding not done yet), and
 * not at all when that launch came from a link, which already carries the pairing.
 */
export async function checkDeferredPairing(
  launchedWithLink: boolean,
): Promise<DeferredPairing | null> {
  if ((await getSetting(CHECKED_KEY)) === 'true') return null;
  await setSetting(CHECKED_KEY, 'true');
  // An update to a build with this check, not an install: nothing was handed over.
  if (launchedWithLink || (await isOnboardingComplete())) return null;

  if (Platform.OS === 'android') {
    const referrer = await Application.getInstallReferrerAsync().catch(() => null);
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
      Clipboard.hasUrlAsync().catch(() => false),
      Clipboard.hasStringAsync().catch(() => false),
    ]);
    uploadLog.info(`deferred pairing: pasteboard url=${hasUrl} string=${hasString}`);
    if (hasUrl) return { kind: 'pasteboard' };
  }
  return null;
}
