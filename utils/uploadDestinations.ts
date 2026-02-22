import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";

const DESTINATIONS_KEY = "upload_destinations";

export interface UploadDestination {
  id: string;
  name: string;
  server: string;
  token: string;
  expiresAt: string;
}

function normalizeServerUrl(server: string): string {
  try {
    const url = new URL(server);
    return `${url.protocol}//${url.host}`.replace(/\/$/, "");
  } catch {
    return server.replace(/\/$/, "");
  }
}

export async function getAllDestinations(): Promise<UploadDestination[]> {
  try {
    const raw = await AsyncStorage.getItem(DESTINATIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as UploadDestination[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[UploadDestinations] Error loading destinations:", error);
    return [];
  }
}

/** Add or update by normalized server (no duplicates by server). */
export async function addDestination(
  server: string,
  token: string,
  name?: string
): Promise<void> {
  const normalized = normalizeServerUrl(server);
  const list = await getAllDestinations();
  const existing = list.find(
    (d) => normalizeServerUrl(d.server) === normalized
  );
  const expiresAt = parseExpiresAtFromToken(token);
  const newDest: UploadDestination = {
    id: existing?.id ?? Crypto.randomUUID(),
    name: name?.trim() || normalized,
    server: normalized,
    token,
    expiresAt: expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const rest = list.filter((d) => normalizeServerUrl(d.server) !== normalized);
  await AsyncStorage.setItem(
    DESTINATIONS_KEY,
    JSON.stringify([...rest, newDest])
  );
  console.log("[UploadDestinations] Added/updated destination:", newDest.id);
}

function parseExpiresAtFromToken(token: string): string | null {
  try {
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    const decoded = JSON.parse(json);
    const exp = decoded.expiresAt;
    if (typeof exp === "number") {
      return new Date(exp * 1000).toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

export async function removeDestination(id: string): Promise<void> {
  const list = await getAllDestinations();
  const next = list.filter((d) => d.id !== id);
  await AsyncStorage.setItem(DESTINATIONS_KEY, JSON.stringify(next));
  console.log("[UploadDestinations] Removed destination:", id);
}

export async function getDestination(
  id: string
): Promise<UploadDestination | null> {
  const list = await getAllDestinations();
  return list.find((d) => d.id === id) ?? null;
}
