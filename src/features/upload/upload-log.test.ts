import { describe, expect, it } from '@jest/globals';

import {
  describeError,
  describeTransport,
  formatBytes,
  formatRate,
  formatSeconds,
  shortId,
} from './upload-log';
import { TusUploadError } from './tus-client';

describe('upload log formatting', () => {
  it('formats sizes, durations and rates', () => {
    expect(formatBytes(850)).toBe('850 B');
    expect(formatBytes(12_700)).toBe('12.4 KB');
    expect(formatBytes(102_865_306)).toBe('98.1 MB');
    expect(formatSeconds(83_240)).toBe('83.2 s');
    expect(formatRate(8 * 1024 * 1024, 1000)).toBe('8.0 MB/s');
    expect(formatRate(20_172, 1000)).toBe('19.7 KB/s');
    expect(formatRate(1000, 0)).toBe('-');
    expect(shortId('7be07f59-55e9-432b-983c-d29406934193')).toBe('7be07f59');
  });

  it('names the HTTP version, and each attempt when iOS retried on another connection', () => {
    expect(describeTransport('android', null)).toBe('over OkHttp (no HTTP/3 on Android)');
    expect(describeTransport('ios', null)).toBe('over an unknown protocol');
    expect(
      describeTransport('ios', {
        durationMs: 900,
        attempts: [{ protocol: 'h2', reusedConnection: true, bodyBytesSent: 10, durationMs: 900 }],
      }),
    ).toBe('over h2 (reused connection)');
    expect(
      describeTransport('ios', {
        durationMs: 71_000,
        attempts: [
          { protocol: 'h3', reusedConnection: false, bodyBytesSent: 2_831_155, durationMs: 60_000 },
          {
            protocol: 'h2',
            reusedConnection: false,
            bodyBytesSent: 100_034_151,
            durationMs: 11_000,
          },
        ],
      }),
    ).toBe('over h3 → h2 (h3: 2.7 MB in 60.0 s, h2: 95.4 MB in 11.0 s)');
  });

  it('adds the HTTP status to a failure when there was one', () => {
    expect(
      describeError(new TusUploadError('Not allowed', { retryable: false, statusCode: 403 })),
    ).toBe('Not allowed (HTTP 403)');
    expect(
      describeError(
        new TusUploadError('Upload failed (409)', { retryable: true, statusCode: 409 }),
      ),
    ).toBe('Upload failed (409)');
    expect(describeError(new Error('The network connection was lost.'))).toBe(
      'The network connection was lost',
    );
    expect(describeError('boom')).toBe('boom');
  });
});
