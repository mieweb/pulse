import { describe, expect, it } from '@jest/globals';

import { formatEntry, LogBuffer, redact, splitEntries } from './log-buffer';

const NOW = new Date('2026-09-24T14:05:00.000Z');

describe('redact', () => {
  it('blanks a token query param in URLs and pairing links, leaving other params alone', () => {
    expect(
      redact('GET https://vault.example.org/pulsevault/artifacts/x?token=abc.def-123&a=1'),
    ).toBe('GET https://vault.example.org/pulsevault/artifacts/x?token=[redacted]&a=1');
    expect(redact('pulsecam://?v=1&artifactId=x&server=s&token=eyJraWQiOi.sig')).toBe(
      'pulsecam://?v=1&artifactId=x&server=s&token=[redacted]',
    );
  });

  it('blanks a Bearer header and a "token" JSON field', () => {
    expect(redact('Authorization: Bearer eyJ0eXAi.abc.def')).toBe(
      'Authorization: Bearer [redacted]',
    );
    expect(redact('{"server":"s","token":"eyJ0eXAi.abc"}')).toBe(
      '{"server":"s","token":"[redacted]"}',
    );
  });

  it('leaves text without tokens unchanged', () => {
    const text = 'Upload failed (422): checksum mismatch for draft-1.mp4';
    expect(redact(text)).toBe(text);
  });
});

describe('formatEntry', () => {
  it('prefixes the timestamp and level, and joins the arguments', () => {
    expect(formatEntry('warn', ['upload', 3, { ok: false }], NOW)).toBe(
      '2026-09-24T14:05:00.000Z WARN upload 3 {"ok":false}',
    );
  });

  it('includes an error stack, and survives circular objects', () => {
    const error = new Error('boom');
    expect(formatEntry('error', [error], NOW)).toContain('Error: boom');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatEntry('info', [circular], NOW)).toBe(
      '2026-09-24T14:05:00.000Z INFO [object Object]',
    );
  });

  it('redacts tokens in any argument', () => {
    expect(formatEntry('info', ['linked', { token: 'secret' }], NOW)).toContain(
      '"token":"[redacted]"',
    );
  });
});

describe('splitEntries', () => {
  it('keeps a multi-line stack as one entry', () => {
    const a = '2026-09-24T14:05:00.000Z ERROR Error: boom\n    at f (x.js:1)\n    at g (y.js:2)';
    const b = '2026-09-24T14:05:01.000Z INFO next';
    expect(splitEntries(`${a}\n${b}\n`)).toEqual([a, b]);
    expect(splitEntries('')).toEqual([]);
  });
});

describe('LogBuffer', () => {
  it('keeps only the most recent entries', () => {
    const buffer = new LogBuffer(3);
    for (const n of [1, 2, 3, 4, 5]) buffer.push(`e${n}`);
    expect(buffer.all()).toEqual(['e3', 'e4', 'e5']);
    buffer.load(['a', 'b', 'c', 'd']);
    expect(buffer.all()).toEqual(['b', 'c', 'd']);
    expect(buffer.size).toBe(3);
  });
});
