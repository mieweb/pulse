/**
 * Embedded Pulse doesn't use the clipboard: only the Pulse app's pairing and its upload
 * announcement do (B6). A copy reports that nothing was copied, and nothing reads as there.
 */
export async function setStringAsync(): Promise<boolean> {
  return false;
}

export async function getStringAsync(): Promise<string> {
  return '';
}

export async function hasStringAsync(): Promise<boolean> {
  return false;
}

export async function hasUrlAsync(): Promise<boolean> {
  return false;
}
