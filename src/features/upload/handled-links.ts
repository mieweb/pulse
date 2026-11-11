import { getSetting, setSetting } from '@/db/settings';

const KEY = 'pairing.handledLinks';

/** How many upload ids are remembered: far more than a person opens between two launches. */
const MAX_REMEMBERED = 200;

/** What a link for a place came to: it was paired, or its server refused its token. */
export type LinkOutcome = 'paired' | 'refused';

/** How a refused link's upload id is stored; a paired one is stored as it is. */
const REFUSED = 'refused:';
const entryFor = (artifactId: string, outcome: LinkOutcome) =>
  outcome === 'refused' ? REFUSED + artifactId : artifactId;

/** The stored list, oldest first; anything unreadable is an empty one. */
export function parseHandled(value: string | null | undefined): string[] {
  try {
    const list: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** `list` with `entry` as its newest, the oldest dropped past `MAX_REMEMBERED`. */
export function withHandled(list: readonly string[], entry: string): string[] {
  return [...list.filter((id) => id !== entry), entry].slice(-MAX_REMEMBERED);
}

/**
 * What became of the link with this upload id, if it was a link for a place that Pulse paired or
 * that its server refused; `null` for one it has never dealt with. Kept across launches, in the
 * settings table, because the link an app was launched with can be handed to it again: Android
 * gives a relaunch from Recents the intent that first started the app, long after that link was
 * used. Such a link is not paired a second time (see `screenLink`).
 *
 * An upload id is in the link and in `upload_destinations` in the clear; it is no secret.
 */
export async function handledLinkOutcome(artifactId: string): Promise<LinkOutcome | null> {
  const list = parseHandled(await getSetting(KEY));
  if (list.includes(artifactId)) return 'paired';
  return list.includes(REFUSED + artifactId) ? 'refused' : null;
}

// Each write reads the list and writes it back, so they go one at a time.
let writeQueue: Promise<unknown> = Promise.resolve();

/** Remember what the link for this upload id came to. */
export function rememberHandledLink(artifactId: string, outcome: LinkOutcome): Promise<void> {
  const result = writeQueue.then(async () => {
    const entry = entryFor(artifactId, outcome);
    const other = entryFor(artifactId, outcome === 'paired' ? 'refused' : 'paired');
    const list = parseHandled(await getSetting(KEY));
    if (list[list.length - 1] === entry) return;
    const rest = list.filter((id) => id !== other);
    await setSetting(KEY, JSON.stringify(withHandled(rest, entry)));
  });
  writeQueue = result.catch(() => {});
  return result;
}
