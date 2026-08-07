import { describe, expect, it, jest } from '@jest/globals';

import { type ByteReader, scanForFaststart } from './faststart';

// The module imports expo-file-system for `hasFaststart`, which jest cannot parse as shipped.
// These cases only exercise the pure scanner, so a stub is enough to let the import resolve.
jest.mock('expo-file-system', () => ({ File: class {} }));

/**
 * Build a fake MP4 as a list of top-level boxes and hand back a reader over it. Only the
 * headers matter to the scanner, so box bodies are zero-filled: a real `mdat` is hundreds
 * of megabytes and the whole point is that we never read it.
 */
function mp4(boxes: { type: string; size: number }[]): ByteReader {
  const total = boxes.reduce((n, b) => n + b.size, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const box of boxes) {
    bytes[at] = (box.size >>> 24) & 0xff;
    bytes[at + 1] = (box.size >>> 16) & 0xff;
    bytes[at + 2] = (box.size >>> 8) & 0xff;
    bytes[at + 3] = box.size & 0xff;
    for (let i = 0; i < 4; i++) bytes[at + 4 + i] = box.type.charCodeAt(i);
    at += box.size;
  }
  return (offset, length) => {
    if (offset >= bytes.length) return null;
    return bytes.subarray(offset, Math.min(offset + length, bytes.length));
  };
}

describe('scanForFaststart', () => {
  it('reports faststart when moov precedes mdat', () => {
    expect(
      scanForFaststart(
        mp4([
          { type: 'ftyp', size: 32 },
          { type: 'moov', size: 4096 },
          { type: 'mdat', size: 1024 },
        ]),
      ),
    ).toBe(true);
  });

  it('reports moov-at-end for a raw recorder clip', () => {
    // What AVCaptureMovieFileOutput writes: ftyp, then samples, then the index.
    expect(
      scanForFaststart(
        mp4([
          { type: 'ftyp', size: 32 },
          { type: 'mdat', size: 8192 },
          { type: 'moov', size: 4096 },
        ]),
      ),
    ).toBe(false);
  });

  it('skips the filler boxes real writers emit before the payload', () => {
    expect(
      scanForFaststart(
        mp4([
          { type: 'ftyp', size: 32 },
          { type: 'wide', size: 8 },
          { type: 'free', size: 64 },
          { type: 'moov', size: 4096 },
        ]),
      ),
    ).toBe(true);
  });

  it('follows a 64-bit largesize box', () => {
    // size == 1 means the real size lives in the 8 bytes after the header.
    const bytes = new Uint8Array(64);
    const write = (at: number, type: string, size: number, large?: number) => {
      const s = large ? 1 : size;
      bytes[at] = (s >>> 24) & 0xff;
      bytes[at + 1] = (s >>> 16) & 0xff;
      bytes[at + 2] = (s >>> 8) & 0xff;
      bytes[at + 3] = s & 0xff;
      for (let i = 0; i < 4; i++) bytes[at + 4 + i] = type.charCodeAt(i);
      if (large) {
        // High word stays zero; low word carries the size.
        bytes[at + 12] = (large >>> 24) & 0xff;
        bytes[at + 13] = (large >>> 16) & 0xff;
        bytes[at + 14] = (large >>> 8) & 0xff;
        bytes[at + 15] = large & 0xff;
      }
    };
    write(0, 'ftyp', 0, 24);
    write(24, 'moov', 16);

    const read: ByteReader = (offset, length) =>
      offset >= bytes.length
        ? null
        : bytes.subarray(offset, Math.min(offset + length, bytes.length));
    expect(scanForFaststart(read)).toBe(true);
  });

  it('gives up rather than guessing on a short read', () => {
    expect(scanForFaststart(() => new Uint8Array(4))).toBeNull();
    expect(scanForFaststart(() => null)).toBeNull();
  });

  it('gives up on a malformed size instead of looping forever', () => {
    // A box claiming to be smaller than its own header would never advance the cursor.
    expect(scanForFaststart(mp4([{ type: 'ftyp', size: 4 }]))).toBeNull();
  });

  it('gives up when a box runs to the end of the file before moov', () => {
    // size == 0 means "to EOF", so nothing follows and we never saw an index.
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 4; i++) bytes[4 + i] = 'mdaX'.charCodeAt(i);
    expect(
      scanForFaststart((offset, length) =>
        offset >= bytes.length ? null : bytes.subarray(offset, offset + length),
      ),
    ).toBeNull();
  });

  it('gives up on a file that is not an MP4 at all', () => {
    expect(scanForFaststart(mp4([{ type: 'RIFF', size: 32 }]))).toBeNull();
  });
});
