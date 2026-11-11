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
      '….com.abcdefghijklmnopqrstuvwxyz.com',
    );
    // As many whole subdomains as fit, nearest the domain first.
    expect(shortHost('timehuddle.com.some-long-label.pulse.evil.example')).toBe(
      '….pulse.evil.example',
    );
  });

  it('keeps a registrable domain whole even when it alone is longer than the limit', () => {
    const domain = `${'a'.repeat(40)}.example`;
    expect(shortHost(`login.timehuddle.${domain}`)).toBe(`….timehuddle.${domain}`);
  });

  it('keeps the port with the domain', () => {
    expect(shortHost('timehuddle.com.abcdefghijklmnopqrstuvwxyz.com:8443')).toBe(
      '….com.abcdefghijklmnopqrstuvwxyz.com:8443',
    );
  });

  it('keeps the domain of a host written with its final dot, with a port or without', () => {
    expect(shortHost('timehuddle.com.abcdefghijklmnopqrstuvwxyz.com.')).toBe(
      '….com.abcdefghijklmnopqrstuvwxyz.com.',
    );
    expect(shortHost('timehuddle.com.abcdefghijklmnopqrstuvwxyz.com.:8443')).toBe(
      '….com.abcdefghijklmnopqrstuvwxyz.com.:8443',
    );
  });

  it('keeps the registrable label under any public suffix of two labels, listed or not', () => {
    const prefix = 'timehuddle.com.some-very-long-label';
    expect(shortHost(`${prefix}.evil.co.uk`)).toBe('….evil.co.uk');
    expect(shortHost(`${prefix}.abcdefghijklmnopqrstuvwxyz.ne.jp`)).toBe(
      '….abcdefghijklmnopqrstuvwxyz.ne.jp',
    );
    expect(shortHost(`${prefix}.evil.id.au`)).toBe('….evil.id.au');
    // A private suffix: each user's site is its own.
    expect(shortHost(`${prefix}.someone.github.io`)).toBe('….someone.github.io');
  });

  it('never shortens an IP address', () => {
    const v6 = '[2001:db8:85a3:0:0:8a2e:370:7334]:8443';
    expect(shortHost(v6)).toBe(v6);
    expect(shortHost('192.168.100.200:65535', 16)).toBe('192.168.100.200:65535');
  });
});
