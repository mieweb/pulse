import { describe, expect, it } from '@jest/globals';

import {
  APP_PROTOCOL,
  appVersionLabel,
  clientHeaders,
  protocolRangeLabel,
  pulseClientHeader,
  setClientIdentity,
} from './client-identity';

describe('client identity', () => {
  it('before startup sets it, says it is an unknown Pulse and sends no appVersion', () => {
    expect(appVersionLabel()).toBeNull();
    expect(pulseClientHeader()).toBe(
      `Pulse/unknown; protocol=${APP_PROTOCOL.min}-${APP_PROTOCOL.max}`,
    );
  });

  it('describes this build in the Pulse-Client header and appVersion', () => {
    setClientIdentity({ version: '2.1.0', build: '45', platform: 'ios' });
    expect(pulseClientHeader()).toBe('Pulse/2.1.0 (45; ios); protocol=1-2');
    expect(clientHeaders()).toEqual({ 'Pulse-Client': 'Pulse/2.1.0 (45; ios); protocol=1-2' });
    expect(appVersionLabel()).toBe('2.1.0 (45)');

    setClientIdentity({ version: '2.1.0', build: null, platform: 'android' });
    expect(pulseClientHeader()).toBe('Pulse/2.1.0 (android); protocol=1-2');
    expect(appVersionLabel()).toBe('2.1.0');
  });

  it('matches the Pulse-Client format the server parses (PROTOCOL.md §7.2)', () => {
    setClientIdentity({ version: '2.1.0', build: '45', platform: 'ios' });
    const match = pulseClientHeader().match(/(?:^|;)\s*protocol=(\d+)(?:-(\d+))?\s*(?:;|$)/);
    expect(match?.slice(1, 3)).toEqual(['1', '2']);
  });

  it('labels a protocol range', () => {
    expect(protocolRangeLabel({ min: 1, max: 2 })).toBe('1–2');
    expect(protocolRangeLabel({ min: 2, max: 2 })).toBe('2');
  });
});
