import { describe, expect, it } from '@jest/globals';

import { describeError, formatBytes, formatRate, formatSeconds, shortId } from './upload-log';
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
