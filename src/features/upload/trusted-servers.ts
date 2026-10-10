import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { settings } from '@/db/schema';
import { getSetting, setSetting } from '@/db/settings';

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
 * Servers the person ticked "Don't ask again" for on the pairing sheet: a later link to the same
 * server (full base URL, path prefix included) pairs without asking. Listed and cleared on the
 * About page.
 */
async function trustedServers(): Promise<string[]> {
  return parse(await getSetting(KEY));
}

export async function isTrustedServer(server: string): Promise<boolean> {
  return (await trustedServers()).includes(server);
}

export async function trustServer(server: string): Promise<void> {
  const list = await trustedServers();
  if (!list.includes(server)) await setSetting(KEY, JSON.stringify([...list, server]));
}

/** Forget one trusted server: its next link asks again. */
export async function untrustServer(server: string): Promise<void> {
  const list = await trustedServers();
  if (list.includes(server))
    await setSetting(KEY, JSON.stringify(list.filter((s) => s !== server)));
}

/** Forget every trusted server: their next links ask again. */
export async function clearTrustedServers(): Promise<void> {
  await db.delete(settings).where(eq(settings.key, KEY));
}

/** The trusted servers, live (sorted for display). */
export function useTrustedServers(): string[] {
  const { data } = useLiveQuery(trustedServersQuery, []);
  return parse(data[0]?.value).sort();
}
