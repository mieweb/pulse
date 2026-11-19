import { afterEach, describe, expect, it } from '@jest/globals';

import {
  checkDiskForRecording,
  LOW_DISK_BYTES,
  lowDiskThreshold,
  setLowDiskThreshold,
} from './low-disk';

const MB = 1024 * 1024;

describe('checkDiskForRecording', () => {
  afterEach(() => setLowDiskThreshold(null));

  it('starts a take with enough space', () => {
    expect(checkDiskForRecording(() => 4096 * MB)).toEqual({ ok: true });
    expect(checkDiskForRecording(() => LOW_DISK_BYTES)).toEqual({ ok: true });
  });

  it('refuses a take under the threshold, saying what is free and what is needed', () => {
    expect(checkDiskForRecording(() => 120 * MB)).toEqual({
      ok: false,
      freeBytes: 120 * MB,
      neededBytes: LOW_DISK_BYTES,
    });
    expect(checkDiskForRecording(() => 0)).toMatchObject({ ok: false, freeBytes: 0 });
  });

  it('takes the threshold it is given', () => {
    expect(checkDiskForRecording(() => 120 * MB, 100 * MB)).toEqual({ ok: true });
    expect(checkDiskForRecording(() => 120 * MB, 200 * MB)).toMatchObject({ ok: false });
  });

  it('never blocks when the free space cannot be read', () => {
    expect(checkDiskForRecording(() => null)).toEqual({ ok: true });
    expect(checkDiskForRecording(() => Number.NaN)).toEqual({ ok: true });
    expect(checkDiskForRecording(() => -1)).toEqual({ ok: true });
    expect(
      checkDiskForRecording(() => {
        throw new Error('statfs failed');
      }),
    ).toEqual({ ok: true });
  });

  it('uses an injected threshold until it is cleared (the device check)', () => {
    setLowDiskThreshold(64 * 1024 * MB);
    expect(lowDiskThreshold()).toBe(64 * 1024 * MB);
    expect(checkDiskForRecording(() => 30 * 1024 * MB)).toMatchObject({ ok: false });
    setLowDiskThreshold(null);
    expect(lowDiskThreshold()).toBe(LOW_DISK_BYTES);
    expect(checkDiskForRecording(() => 30 * 1024 * MB)).toEqual({ ok: true });
  });

  it('ignores a threshold that is not a number ≥ 0', () => {
    setLowDiskThreshold(Number.NaN);
    expect(lowDiskThreshold()).toBe(LOW_DISK_BYTES);
    setLowDiskThreshold(-5);
    expect(lowDiskThreshold()).toBe(LOW_DISK_BYTES);
  });
});
