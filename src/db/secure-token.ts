import * as SecureStore from 'expo-secure-store';

/**
 * Upload capability tokens are live bearer credentials (§ pulsevault protocol) — kept in
 * the Keychain/Keystore via expo-secure-store instead of the plain-SQLite `drafts`/
 * `settings` tables, which are unencrypted at rest and readable from an unencrypted device
 * backup or a rooted/jailbroken device.
 */
const draftTokenKey = (draftId: string) => `upload.token.${draftId}`;
const destinationTokenKey = (id: string) => `upload.dest.token.${id}`;
const viewLinkKey = (draftId: string) => `upload.view.${draftId}`;

/**
 * Drafts used to keep a copy of their upload link's token here; nothing writes or reads it any
 * more. Only the one-time cleanup (`draft-token-migration.ts`) still deletes the old copies.
 */
export async function deleteDraftToken(draftId: string): Promise<void> {
  await SecureStore.deleteItemAsync(draftTokenKey(draftId));
}

export async function getDestinationToken(id: string): Promise<string | null> {
  return (await SecureStore.getItemAsync(destinationTokenKey(id))) ?? null;
}

export async function setDestinationToken(id: string, token: string | null): Promise<void> {
  if (token) await SecureStore.setItemAsync(destinationTokenKey(id), token);
  else await SecureStore.deleteItemAsync(destinationTokenKey(id));
}

export async function deleteDestinationToken(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(destinationTokenKey(id));
}

/**
 * An uploaded draft's read-only view link (a URL carrying a view token, PROTOCOL.md §6.4) and
 * when it stops working, in ms since the epoch. A bearer secret for watching the video, so it
 * lives here, not in SQLite.
 */
export type StoredViewLink = { url: string; expiresAt: number };

export async function getViewLink(draftId: string): Promise<StoredViewLink | null> {
  const raw = await SecureStore.getItemAsync(viewLinkKey(draftId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredViewLink>;
    if (typeof parsed.url !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    return { url: parsed.url, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export async function setViewLink(draftId: string, link: StoredViewLink): Promise<void> {
  await SecureStore.setItemAsync(viewLinkKey(draftId), JSON.stringify(link));
}

export async function deleteViewLink(draftId: string): Promise<void> {
  await SecureStore.deleteItemAsync(viewLinkKey(draftId));
}
