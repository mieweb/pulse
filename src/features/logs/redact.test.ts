import { describe, expect, it } from '@jest/globals';

import { REDACTED, redact } from './redact';

// A capability token as PulseVault issues it: base64url(JSON claims).signature.
const CLAIMS = Buffer.from(JSON.stringify({ ref: 'ticket:42', exp: 1_900_000_000 })).toString(
  'base64url',
);
const CAPABILITY = `${CLAIMS}.Zm9vYmFyYmF6cXV4c2lnbmF0dXJlMTIz`;
const JWT = `${CLAIMS}.${CLAIMS}.c2lnbmF0dXJl`;

describe('redact', () => {
  it('blanks token fields in JSON, quoted or not', () => {
    expect(redact('{"token":"abc123","name":"Fix login"}')).toBe(
      `{"token":"${REDACTED}","name":"Fix login"}`,
    );
    expect(redact('{"uploadToken": "s3cr3t", "access_token":"x"}')).toBe(
      `{"uploadToken": "${REDACTED}", "access_token":"${REDACTED}"}`,
    );
    expect(redact('{"apiKey":12345}')).toBe(`{"apiKey":"${REDACTED}"}`);
    expect(redact(`{'password': 'hunter2'}`)).toBe(`{'password': "${REDACTED}"}`);
  });

  it('keeps fields that only start like a credential', () => {
    const line = '{"tokenExpiresAt":"2026-11-19T00:00:00Z","tokens":3}';
    expect(redact(line)).toBe(line);
  });

  it('blanks Authorization headers, as a header line or a JSON field', () => {
    expect(redact('PATCH /files/1 Authorization: Basic dXNlcjpwYXNz')).toBe(
      `PATCH /files/1 Authorization: ${REDACTED}`,
    );
    expect(redact('{"headers":{"Authorization":"Bearer abc.def"}}')).toBe(
      `{"headers":{"Authorization":"${REDACTED}"}}`,
    );
    expect(redact('cookie: sid=1; theme=dark')).toBe(`cookie: ${REDACTED}`);
  });

  it('blanks Bearer and Basic credentials anywhere', () => {
    expect(redact("headers: { Authorization: 'Bearer abc-123_x' }")).toBe(
      `headers: { Authorization: 'Bearer ${REDACTED}' }`,
    );
    expect(redact('sent Basic dXNlcjpwYXNz to the server')).toBe(
      `sent Basic ${REDACTED} to the server`,
    );
  });

  it('blanks token parameters in links, in the query or the fragment', () => {
    expect(redact('https://h.example/upload?ref=ticket:42&token=abc&x=1')).toBe(
      `https://h.example/upload?ref=ticket:42&token=${REDACTED}&x=1`,
    );
    expect(redact('https://h.example/p#token=abc')).toBe(`https://h.example/p#token=${REDACTED}`);
    expect(redact('pulsecam://?server=h&token=abc')).toBe(`pulsecam://?server=h&token=${REDACTED}`);
    expect(redact('retry secret=xyz after 2s')).toBe(`retry secret=${REDACTED} after 2s`);
  });

  it('blanks a credential named in a plain log line', () => {
    expect(redact('[upload] token: 0f3a9c, part 2')).toBe(`[upload] token: ${REDACTED}, part 2`);
  });

  it('blanks capability-token-shaped strings wherever they appear', () => {
    expect(redact(`claimed ${CAPABILITY} for ticket 42`)).toBe(`claimed ${REDACTED} for ticket 42`);
    expect(redact(`jwt=${JWT}`)).not.toContain(CLAIMS);
    expect(redact(`["${CAPABILITY}"]`)).toBe(`["${REDACTED}"]`);
  });

  it('leaves ordinary lines alone', () => {
    const line = '2026-11-19T10:00:00.000Z INFO [outbox] job 7 queued (3 parts, 41 MB) ok';
    expect(redact(line)).toBe(line);
    expect(redact('Basic plan; Bearer of good news')).toContain('Basic plan');
  });

  it('changes nothing the second time', () => {
    const lines = [
      '{"token":"abc","Authorization":"Bearer x"}',
      'Authorization: Basic abc',
      `https://h/?token=abc ${CAPABILITY}`,
      'token: abc',
    ];
    for (const line of lines) {
      const once = redact(line);
      expect(redact(once)).toBe(once);
    }
  });
});
