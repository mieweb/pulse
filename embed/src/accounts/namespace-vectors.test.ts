import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The account namespace rule (native-bridge.md §4), recomputed in Node from
// embed/native/ios/namespace-vectors.json. PulseKit computes namespaces in Swift
// (PulseKitAccounts.swift, CryptoKit); Pulse JS never does, it gets its folders as props. The same
// file is what the owner compares on a device, so a namespace a host sees can be checked by hand.

type Vectors = {
  format: string;
  version: number;
  vectors: {
    name: string;
    hostId: string;
    serverOrigin: string;
    userId: string;
    origin: string;
    namespace: string;
  }[];
  invalidOrigins: string[];
};

const vectors = JSON.parse(
  readFileSync(join(__dirname, '../../native/ios/namespace-vectors.json'), 'utf8'),
) as Vectors;

/**
 * The origin rule, as PulseOrigin.normalise in PulseKitAccounts.swift writes it: http or https,
 * an ASCII host, a port only when it isn't the scheme's default, lowercased; any path, query or
 * fragment dropped. Anything else (credentials, IPv6 literals, non-ASCII hosts) is refused.
 */
function originOf(serverOrigin: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(serverOrigin);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  const authority = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(m[2]);
  if (!authority) return null;
  const host = authority[1].toLowerCase();
  if (!/[a-z0-9]/.test(host)) return null;
  const port = authority[2] === undefined ? null : Number(authority[2]);
  if (port !== null && (port < 1 || port > 65535)) return null;
  const shown = port === null || port === (scheme === 'http' ? 80 : 443) ? '' : `:${port}`;
  return `${scheme}://${host}${shown}`;
}

function namespaceOf(hostId: string, origin: string, userId: string): string {
  const digest = createHash('sha256').update(`${origin}\n${userId}`, 'utf8').digest('hex');
  return `${hostId}-${digest.slice(0, 16)}`;
}

describe('namespace vectors', () => {
  it('is the vectors file this test knows, with five vectors', () => {
    expect(vectors.format).toBe('pulsekit-namespace-vectors');
    expect(vectors.version).toBe(1);
    expect(vectors.vectors).toHaveLength(5);
  });

  describe.each(vectors.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    it('normalises the origin', () => {
      expect(originOf(v.serverOrigin)).toBe(v.origin);
    });

    it('hashes origin + "\\n" + userId into the namespace', () => {
      expect(namespaceOf(v.hostId, v.origin, v.userId)).toBe(v.namespace);
    });

    it('is a plain folder name: 1–64 of [A-Za-z0-9._-]', () => {
      expect(v.namespace).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
      expect(v.namespace.startsWith(`${v.hostId}-`)).toBe(true);
      expect(v.namespace.slice(v.hostId.length + 1)).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  it('gives the same namespace for origins that differ only in case, default port and path', () => {
    const [plain, noisy] = vectors.vectors;
    expect(noisy.serverOrigin).not.toBe(plain.serverOrigin);
    expect(noisy.namespace).toBe(plain.namespace);
  });

  it('gives different namespaces to different people, servers and hosts', () => {
    const distinct = new Set(vectors.vectors.slice(1).map((v) => v.namespace));
    expect(distinct.size).toBe(vectors.vectors.length - 1);
  });

  it('hashes the userId as given: a decomposed é is not normalised to a precomposed one', () => {
    const v = vectors.vectors.find((x) => x.userId.includes('́'));
    expect(v).toBeDefined();
    if (!v) return;
    expect(namespaceOf(v.hostId, v.origin, v.userId.normalize('NFC'))).not.toBe(v.namespace);
  });

  it.each(vectors.invalidOrigins)('refuses the origin %j', (origin) => {
    expect(originOf(origin)).toBeNull();
  });
});
