import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { settings } from '@/db/schema';
import { getSetting, setSetting } from '@/db/settings';
import { hostOf } from '@/utils/format';

const KEY = 'pairing.trustedServers';

const trustedServersQuery = db
  .select({ value: settings.value })
  .from(settings)
  .where(eq(settings.key, KEY));

function parse(value: string | null | undefined): string[] {
  try {
    const list: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Hosts the person ticked "Don't ask again" for on the pairing sheet: a later link to a server on
 * the same host pairs without asking. Kept by host, not full base URL, because the host is all
 * the sheet shows when the person decides. Listed and cleared on the About page.
 */
async function trustedHosts(): Promise<string[]> {
  return parse(await getSetting(KEY));
}

/**
 * Writes one at a time: each reads the list and writes it back, so two at once (two rows removed
 * in quick succession) would lose one of the changes.
 */
let writeQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(run, run);
  writeQueue = result.catch(() => {});
  return result;
}

export async function isTrustedServer(server: string): Promise<boolean> {
  return (await trustedHosts()).includes(hostOf(server));
}

/** Trust the host of `server` (a pairing link's base URL). */
export function trustServer(server: string): Promise<void> {
  const host = hostOf(server);
  return oneAtATime(async () => {
    const list = await trustedHosts();
    if (!list.includes(host)) await setSetting(KEY, JSON.stringify([...list, host]));
  });
}

/** Forget one trusted host (as listed by `useTrustedServers`): its next link asks again. */
export function untrustServer(host: string): Promise<void> {
  return oneAtATime(async () => {
    const list = await trustedHosts();
    if (list.includes(host)) await setSetting(KEY, JSON.stringify(list.filter((h) => h !== host)));
  });
}

/** Forget every trusted host: their next links ask again. */
export function clearTrustedServers(): Promise<void> {
  return oneAtATime(async () => {
    await db.delete(settings).where(eq(settings.key, KEY));
  });
}

/** The trusted hosts, live (sorted for display). */
export function useTrustedServers(): string[] {
  const { data } = useLiveQuery(trustedServersQuery, []);
  return parse(data[0]?.value).sort();
}
