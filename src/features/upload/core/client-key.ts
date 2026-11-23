import * as Crypto from 'expo-crypto';

import { installationId } from '@/db/local-settings';

// The two keys an embedded upload is known by (AD32, pulse-schema.md §3.1):
//   draftKey  = `${installationId}:${draftId}`          one video, the same across edits and Moves
//   clientKey = `${installationId}:${draftId}:${sig16}` one attempt at sending exactly this cut
// sig16 is the first 16 hex digits of SHA-256 over the draft's merged signature: any edit changes
// the signature, so it changes the clientKey; sending again with no edit gives the same one, and
// the server answers with the same upload.

/** The first 16 lower-case hex digits of SHA-256 over `mergedSignature` (UTF-8). */
export async function sig16(mergedSignature: string): Promise<string> {
  const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, mergedSignature, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
  return hex.toLowerCase().slice(0, 16);
}

export function draftKeyOf(installation: string, draftId: string): string {
  return `${installation}:${draftId}`;
}

export function clientKeyOf(installation: string, draftId: string, signature16: string): string {
  return `${draftKeyOf(installation, draftId)}:${signature16}`;
}

/** The draft's keys for a Send of the cut whose merged signature is `mergedSignature`. */
export async function jobKeys(
  draftId: string,
  mergedSignature: string,
): Promise<{ draftKey: string; clientKey: string }> {
  const installation = installationId();
  return {
    draftKey: draftKeyOf(installation, draftId),
    clientKey: clientKeyOf(installation, draftId, await sig16(mergedSignature)),
  };
}
