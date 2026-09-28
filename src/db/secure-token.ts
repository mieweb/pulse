import * as SecureStore from 'expo-secure-store';

/**
 * Upload capability tokens are live bearer credentials (§ pulsevault protocol) — kept in
 * the Keychain/Keystore via expo-secure-store instead of the plain-SQLite `drafts`/
 * `settings` tables, which are unencrypted at rest and readable from an unencrypted device
 * backup or a rooted/jailbroken device.
 */
const draftTokenKey = (draftId: string) => `upload.token.${draftId}`;
const destinationTokenKey = (id: string) => `upload.dest.token.${id}`;
// Named for view links, the first kind saved; kept so links saved before plain ones still load.
const sharedLinkKey = (draftId: string) => `upload.view.${draftId}`;

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
 * An uploaded draft's shareable link, kept across restarts: a read-only view link (a URL carrying
 * a view token, PROTOCOL.md §6.4) or, from a server without tokens, the plain video link.
 * `expiresAt` is when it stops working, in ms since the epoch, or `null` for a plain link, which
 * doesn't expire. A view link is a bearer secret for watching the video, so these live here, not
 * in SQLite. A link carrying the upload token is never saved.
 */
export type SavedLink = { url: string; expiresAt: number | null };

export async function getSavedLink(draftId: string): Promise<SavedLink | null> {
  const raw = await SecureStore.getItemAsync(sharedLinkKey(draftId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SavedLink>;
    if (typeof parsed.url !== 'string') return null;
    if (typeof parsed.expiresAt !== 'number' && parsed.expiresAt !== null) return null;
    return { url: parsed.url, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

export async function setSavedLink(draftId: string, link: SavedLink): Promise<void> {
  await SecureStore.setItemAsync(sharedLinkKey(draftId), JSON.stringify(link));
}

export async function deleteSavedLink(draftId: string): Promise<void> {
  await SecureStore.deleteItemAsync(sharedLinkKey(draftId));
}
