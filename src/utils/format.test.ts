import { describe, expect, it } from '@jest/globals';

import { shortHost } from './format';

describe('shortHost', () => {
  it('leaves a host that fits as it is', () => {
    expect(shortHost('vault.example.org')).toBe('vault.example.org');
    expect(shortHost('vault.example.org:8443')).toBe('vault.example.org:8443');
  });

  it('keeps the whole registrable domain, and drops only subdomains before it', () => {
    // No part of the misleading prefix is shown, and none of the real domain is cut.
    expect(shortHost('timehuddle.com.abcdefghijklmnopqrstuvwxyz.com')).toBe(
      '….abcdefghijklmnopqrstuvwxyz.com',
    );
    // As many whole subdomains as fit, nearest the domain first.
    expect(shortHost('timehuddle.com.some-long-label.pulse.evil.example')).toBe(
      '….pulse.evil.example',
    );
  });

  it('keeps a registrable domain whole even when it alone is longer than the limit', () => {
    const domain = `${'a'.repeat(40)}.example`;
    expect(shortHost(`login.${domain}`)).toBe(`….${domain}`);
  });

  it('keeps the port with the domain', () => {
    expect(shortHost('timehuddle.com.abcdefghijklmnopqrstuvwxyz.com:8443')).toBe(
      '….abcdefghijklmnopqrstuvwxyz.com:8443',
    );
  });

  it('keeps three labels for a two-part public suffix', () => {
    expect(shortHost('timehuddle.com.some-very-long-label.evil.co.uk')).toBe('….evil.co.uk');
  });

  it('never shortens an IP address', () => {
    const v6 = '[2001:db8:85a3:0:0:8a2e:370:7334]:8443';
    expect(shortHost(v6)).toBe(v6);
    expect(shortHost('192.168.100.200:65535', 16)).toBe('192.168.100.200:65535');
  });
});
