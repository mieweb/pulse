import { describe, expect, it } from '@jest/globals';

import { hostOf } from './format';
import { parseHttpUrl } from './http-url';

const cp = String.fromCodePoint;

describe('parseHttpUrl', () => {
  it('reads the scheme and host of an ordinary URL', () => {
    expect(parseHttpUrl('https://vault.example.org/pulsevault')).toEqual({
      protocol: 'https:',
      host: 'vault.example.org',
      hostname: 'vault.example.org',
      credentials: false,
    });
    expect(parseHttpUrl('http://localhost:3000')).toMatchObject({
      protocol: 'http:',
      host: 'localhost:3000',
      hostname: 'localhost',
    });
    expect(parseHttpUrl('HTTPS://Vault.Example.ORG:8443/x?y#z')).toMatchObject({
      protocol: 'https:',
      host: 'vault.example.org:8443',
      hostname: 'vault.example.org',
    });
    expect(parseHttpUrl('http://[::1]:8080/x')).toMatchObject({
      host: '[::1]:8080',
      hostname: '[::1]',
    });
    expect(parseHttpUrl('https://vault.example.org?x=1')).toMatchObject({
      host: 'vault.example.org',
    });
  });

  it('takes the host a request goes to, not one the URL only appears to have', () => {
    // An `@` after the first slash is part of the path: React Native's own URL reads these as
    // `good.example.org`, and every request goes to `evil.example`.
    for (const url of [
      'https://evil.example/x@good.example.org',
      'https://evil.example/pulsevault?x@good.example.org',
      'https://evil.example#@good.example.org',
      'https://evil.example/a:b@good.example.org/pulsevault',
    ]) {
      expect(parseHttpUrl(url)).toMatchObject({ host: 'evil.example', credentials: false });
    }
    // An `@` before it is a username: the host is what follows.
    expect(parseHttpUrl('https://good.example.org@evil.example/')).toMatchObject({
      host: 'evil.example',
      credentials: true,
    });
    expect(parseHttpUrl('https://good.example.org:x@a@evil.example/')).toMatchObject({
      host: 'evil.example',
      credentials: true,
    });
  });

  it('refuses a URL two parsers could split differently', () => {
    for (const url of [
      `https://good.example.org${cp(0x5c)}@evil.example/`,
      'https://good.example.org /x',
      `https://good.example.org/x${cp(0x0a)}`,
      `https://good.example.org${cp(0x09)}.evil.example/`,
    ]) {
      expect(parseHttpUrl(url)).toBeNull();
    }
  });

  it('refuses what isn’t an http(s) URL with a host', () => {
    for (const url of [
      '',
      'not a url',
      'ftp://vault.example.org',
      'javascript:alert(1)',
      'https:/vault.example.org',
      'https://',
      'https:///path',
      'https://:8080/',
      'https://user@/',
      '//vault.example.org',
    ]) {
      expect(parseHttpUrl(url)).toBeNull();
    }
  });
});

describe('hostOf', () => {
  it('is the host a person is asked to trust: the one requests really go to', () => {
    expect(hostOf('https://vault.example.org/pulsevault')).toBe('vault.example.org');
    expect(hostOf('http://192.168.1.20:3000/pulsevault')).toBe('192.168.1.20:3000');
    expect(hostOf('https://evil.example/x@vault.example.org')).toBe('evil.example');
    expect(hostOf('https://vault.example.org@evil.example/pulsevault')).toBe('evil.example');
  });

  it('gives back what it can’t read, as it always has', () => {
    expect(hostOf('not a url')).toBe('not a url');
    expect(hostOf('')).toBe('');
  });
});
