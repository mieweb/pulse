import { File } from 'expo-file-system';

/**
 * Faststart detection (§ playback).
 *
 * An MP4 is a flat sequence of boxes, each `[4-byte big-endian size][4-byte ASCII type]`.
 * "Faststart" just means the `moov` box (the index a player needs before it can render a
 * single frame) sits ahead of `mdat` (the samples) rather than after it. With `moov` last,
 * a browser has to fetch or seek to the tail of the file before playback can begin, which
 * on a 100 MB upload over a phone network is the difference between "plays" and "spins".
 *
 * `probeVideo()` cannot see this — it reports codecs and geometry, not box order — which is
 * why {@link decideUploadContract} deliberately says nothing about faststart. So we read the
 * box headers ourselves. It costs two ranged reads of 16 bytes: the walk stops at whichever
 * of `moov`/`mdat` comes first, and in a real file that is the second or third box.
 *
 * This matters because the two upload paths that skip the merge engine — a single-clip draft
 * (`use-export.ts` returns the recorder's file verbatim) and every segment upload — hand us a
 * raw `AVCaptureMovieFileOutput` file, and that API has no faststart option at all. Those
 * files are always `moov`-at-end. Everything the merge/compress layer writes already has
 * `+faststart` applied by the video-trim fork.
 */

/** Reads `length` bytes at `offset`. Returns null (or a short read) at EOF or on error. */
export type ByteReader = (offset: number, length: number) => Uint8Array | null;

/** Boxes to walk before giving up. Real files reach `moov`/`mdat` within two or three. */
const MAX_BOXES = 8;

/** A 64-bit `largesize` needs 8 more bytes after the 8-byte header. */
const HEADER_BYTES = 16;

function readU32(b: Uint8Array, at: number): number {
  return ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
}

function boxType(b: Uint8Array): string {
  return String.fromCharCode(b[4], b[5], b[6], b[7]);
}

/**
 * Walk the top-level boxes and report whether `moov` precedes `mdat`.
 *
 * Returns `true` for faststart, `false` for `moov`-at-end, and **`null` for "cannot tell"** —
 * a short read, a malformed size, a non-MP4 container, or a file that runs out of boxes.
 * Callers must treat `null` as "leave it alone": guessing wrong here costs a needless
 * re-encode on every upload, which is worse than the stall it would be trying to avoid.
 *
 * Pure, so the parsing is testable without a device or a real file.
 */
export function scanForFaststart(read: ByteReader): boolean | null {
  let offset = 0;

  for (let i = 0; i < MAX_BOXES; i++) {
    const head = read(offset, HEADER_BYTES);
    if (!head || head.length < 8) return null;

    const type = boxType(head);
    if (type === 'moov') return true;
    if (type === 'mdat') return false;

    let size = readU32(head, 0);
    if (size === 1) {
      // 64-bit largesize. Split across two u32 reads because a single u64 does not fit a
      // JS number; anything past 2^53 is not a file we could have written anyway.
      if (head.length < 16) return null;
      size = readU32(head, 8) * 2 ** 32 + readU32(head, 12);
    } else if (size === 0) {
      // "Extends to end of file", so there is no box after this one and we never saw `moov`.
      return null;
    }

    // A box cannot be smaller than its own header; a zero/negative step would spin forever.
    if (!Number.isSafeInteger(size) || size < 8) return null;
    offset += size;
  }

  return null;
}

/**
 * {@link scanForFaststart} against a real file. Never throws: any failure reads as `null`,
 * which the gate treats as "do nothing".
 */
export function hasFaststart(uri: string): boolean | null {
  let handle: ReturnType<File['open']> | null = null;
  try {
    handle = new File(uri).open();
    const h = handle;
    return scanForFaststart((offset, length) => {
      h.offset = offset;
      const bytes = h.readBytes(length);
      return bytes && bytes.length > 0 ? bytes : null;
    });
  } catch (e) {
    console.warn('[contract] could not read box headers; assuming nothing about faststart', e);
    return null;
  } finally {
    try {
      handle?.close();
    } catch {
      // Closing a handle we may never have opened is not worth reporting.
    }
  }
}
