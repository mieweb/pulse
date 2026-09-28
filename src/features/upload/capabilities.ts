import { APP_PROTOCOL, clientHeaders } from './client-identity';
import type { CapabilitiesResponse } from './protocol.gen';

const CAPABILITIES_TIMEOUT_MS = 8000;

/**
 * What the app needs from `GET /capabilities` (PROTOCOL.md §2). Names and types come from the
 * pinned protocol schema (`protocol.gen.ts`); `protocolRevision` is optional because servers
 * speaking protocol 1 predate it.
 */
export type Capabilities = Pick<
  CapabilitiesResponse,
  'protocolVersion' | 'minSupportedVersion' | 'maxSupportedVersion'
> &
  Partial<Pick<CapabilitiesResponse, 'protocolRevision' | 'viewLinks'>>;

type CapabilitiesRejectionReason = 'unreachable' | 'version-too-old' | 'version-too-new';

export type CapabilitiesResult =
  | {
      ok: true;
      capabilities: Capabilities;
      /** The protocol major both sides speak. */
      protocol: number;
    }
  | { ok: false; reason: CapabilitiesRejectionReason };

async function fetchCapabilities(server: string, signal?: AbortSignal): Promise<Capabilities> {
  const timeout = AbortSignal.timeout(CAPABILITIES_TIMEOUT_MS);
  const res = await fetch(`${server}/capabilities`, {
    headers: clientHeaders(),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`Server responded with ${res.status}`);
  const body = (await res.json()) as Partial<CapabilitiesResponse>;
  if (
    typeof body.minSupportedVersion !== 'number' ||
    typeof body.maxSupportedVersion !== 'number'
  ) {
    throw new Error('Server returned an unexpected /capabilities response');
  }
  return {
    protocolVersion: body.protocolVersion ?? body.minSupportedVersion,
    minSupportedVersion: body.minSupportedVersion,
    maxSupportedVersion: body.maxSupportedVersion,
    ...(typeof body.protocolRevision === 'string'
      ? { protocolRevision: body.protocolRevision }
      : {}),
    // Protocol 2.2: whether the server mints read-only view links (PROTOCOL.md §6.4).
    ...(body.viewLinks === true ? { viewLinks: true } : {}),
  };
}

/**
 * Fetches `/capabilities` and checks that this app's protocol range (`APP_PROTOCOL`) overlaps
 * the server's. Pairing runs it, and so does every upload before it starts — the server may
 * have been upgraded since pairing (PROTOCOL.md §7.2).
 *
 * Never rejects, except with an `AbortError` when `signal` aborts (an upload cancelled mid-check).
 */
export async function checkCapabilities(
  server: string,
  signal?: AbortSignal,
): Promise<CapabilitiesResult> {
  let capabilities: Capabilities;
  try {
    capabilities = await fetchCapabilities(server, signal);
  } catch {
    if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    return { ok: false, reason: 'unreachable' };
  }
  if (APP_PROTOCOL.max < capabilities.minSupportedVersion) {
    return { ok: false, reason: 'version-too-old' };
  }
  if (APP_PROTOCOL.min > capabilities.maxSupportedVersion) {
    return { ok: false, reason: 'version-too-new' };
  }
  return {
    ok: true,
    capabilities,
    protocol: Math.min(APP_PROTOCOL.max, capabilities.maxSupportedVersion),
  };
}

export const CAPABILITIES_REJECTION_MESSAGE: Record<CapabilitiesRejectionReason, string> = {
  unreachable: "Couldn't reach that server. Check the connection and try again.",
  'version-too-old': 'This server needs a newer version of Pulse. Update the app and try again.',
  'version-too-new': "This server hasn't been updated to work with this version of Pulse yet.",
};
