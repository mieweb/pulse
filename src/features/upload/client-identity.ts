import pkg from '../../../package.json';

/**
 * Which upload-protocol majors this app speaks (PROTOCOL.md §7), from `package.json`
 * `pulseProtocol` — the one place it's written down. The compatibility page and the About page
 * read the same field. 1–2: protocol 2 only removed `uploadUnit`, which this app ignores.
 */
export const APP_PROTOCOL: { min: number; max: number } = pkg.pulseProtocol;

/** `1` or `1–2`, for display. */
export const protocolRangeLabel = ({ min, max }: { min: number; max: number }) =>
  min === max ? `${min}` : `${min}–${max}`;

type Identity = { version: string; build: string | null; platform: string };

let identity: Identity | null = null;

/** Set once at startup from the build info (see `_layout.tsx`). Pure module so it's testable. */
export function setClientIdentity(next: Identity): void {
  identity = next;
}

/** `2.1.0 (45)`, or `null` before the identity is set. Sent as `Upload-Metadata.appVersion`. */
export function appVersionLabel(): string | null {
  if (!identity) return null;
  return identity.build ? `${identity.version} (${identity.build})` : identity.version;
}

/**
 * The `Pulse-Client` header (PROTOCOL.md §7.2): what this app is and which protocol majors it
 * speaks, e.g. `Pulse/2.1.0 (45; ios); protocol=1-2`. A server refuses a client whose newest
 * major is older than its oldest with `426 Upgrade Required`.
 */
export function pulseClientHeader(): string {
  const details = identity ? [identity.build, identity.platform].filter(Boolean).join('; ') : '';
  const product = `Pulse/${identity?.version ?? 'unknown'}${details ? ` (${details})` : ''}`;
  const range =
    APP_PROTOCOL.min === APP_PROTOCOL.max
      ? `${APP_PROTOCOL.min}`
      : `${APP_PROTOCOL.min}-${APP_PROTOCOL.max}`;
  return `${product}; protocol=${range}`;
}

/** Headers every request to a server carries. */
export function clientHeaders(): Record<string, string> {
  return { 'Pulse-Client': pulseClientHeader() };
}
