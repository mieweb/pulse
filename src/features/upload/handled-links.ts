import { getSetting, setSetting } from '@/db/settings';

const KEY = 'pairing.handledLinks';

/** How many upload ids are remembered: far more than a person opens between two launches. */
const MAX_REMEMBERED = 200;

/** The stored list, oldest first; anything unreadable is an empty one. */
export function parseHandled(value: string | null | undefined): string[] {
  try {
    const list: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** `list` with `artifactId` as its newest entry, the oldest dropped past `MAX_REMEMBERED`. */
export function withHandled(list: readonly string[], artifactId: string): string[] {
  return [...list.filter((id) => id !== artifactId), artifactId].slice(-MAX_REMEMBERED);
}

/**
 * The upload ids of the links for a place that Pulse has dealt with: paired, or refused for good
 * (expired, not accepted by its server). Kept across launches, in the settings table, because the
 * link an app was launched with can be handed to it again: Android gives a relaunch from Recents
 * the intent that first started the app, long after that link was used. Such a link is then
 * neither paired again nor opened in the recorder (see `UploadDeepLinkProvider`).
 *
 * An upload id is in the link and in `upload_destinations` in the clear; it is no secret.
 */
export async function wasLinkHandled(artifactId: string): Promise<boolean> {
  return parseHandled(await getSetting(KEY)).includes(artifactId);
}

// Each write reads the list and writes it back, so they go one at a time.
let writeQueue: Promise<unknown> = Promise.resolve();

/** Remember that the link for this upload id has been dealt with. */
export function rememberHandledLink(artifactId: string): Promise<void> {
  const result = writeQueue.then(async () => {
    const list = parseHandled(await getSetting(KEY));
    if (list[list.length - 1] !== artifactId) {
      await setSetting(KEY, JSON.stringify(withHandled(list, artifactId)));
    }
  });
  writeQueue = result.catch(() => {});
  return result;
}
