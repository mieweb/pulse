import { eq } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import { db } from './client';
import { assertWritable } from './host-context';
import { localSettings } from './schema';

// This install's own values (`local_settings`): never in a backup or a `.pulse` file, and a restore
// leaves them as they were (project.ts `LOCAL_TABLES`).

/** This install's id: the first part of every upload's `draftKey` and `clientKey`. */
const INSTALLATION_ID = 'installationId';
/** Whether uploads wait for Wi-Fi: '1' or '0', mirrored from the host's `configure({policy})`. */
const WIFI_ONLY_UPLOADS = 'wifiOnlyUploads';

function read(key: string): string | null {
  return (
    db
      .select({ value: localSettings.value })
      .from(localSettings)
      .where(eq(localSettings.key, key))
      .get()?.value ?? null
  );
}

/**
 * This install's id, a UUID made the first time it's asked for and the same from then on. Two
 * callers racing to make it both get the one that was stored.
 */
export function installationId(): string {
  const stored = read(INSTALLATION_ID);
  if (stored) return stored;
  assertWritable();
  db.insert(localSettings)
    .values({ key: INSTALLATION_ID, value: Crypto.randomUUID() })
    .onConflictDoNothing()
    .run();
  return read(INSTALLATION_ID)!;
}

/** Whether uploads wait for Wi-Fi (off until the host says otherwise). */
export function wifiOnlyUploads(): boolean {
  return read(WIFI_ONLY_UPLOADS) === '1';
}

/** Store the host's Wi-Fi-only choice. */
export function setWifiOnlyUploads(on: boolean): void {
  const value = on ? '1' : '0';
  if (read(WIFI_ONLY_UPLOADS) === value) return;
  assertWritable();
  db.insert(localSettings)
    .values({ key: WIFI_ONLY_UPLOADS, value })
    .onConflictDoUpdate({ target: localSettings.key, set: { value } })
    .run();
}
