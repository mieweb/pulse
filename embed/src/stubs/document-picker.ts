/**
 * Embedded Pulse picks no documents: only `.pulse` import and library restore do, and both are
 * Pulse-app only (B6). A pick reads as canceled.
 */
export async function getDocumentAsync(): Promise<{ canceled: true; assets: null }> {
  return { canceled: true, assets: null };
}
