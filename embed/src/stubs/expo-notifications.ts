/**
 * Embedded Pulse posts no notifications: the host app owns them. The calls Pulse makes resolve
 * without doing anything, and permission reads as not granted so nothing is ever requested.
 */
export const AndroidImportance = { DEFAULT: 3 } as const;

export async function setNotificationChannelAsync(): Promise<null> {
  return null;
}

export async function getPermissionsAsync(): Promise<{ status: 'denied'; granted: false }> {
  return { status: 'denied', granted: false };
}

export async function requestPermissionsAsync(): Promise<{ status: 'denied'; granted: false }> {
  return { status: 'denied', granted: false };
}

export async function scheduleNotificationAsync(): Promise<string> {
  return '';
}
