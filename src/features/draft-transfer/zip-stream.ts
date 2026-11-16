import { File, FileMode, type FileHandle } from 'expo-file-system';
import { strFromU8, Zip, ZipPassThrough } from 'fflate';

import { nativeMd5 } from '@/utils/disk-space';

// Streamed ZIP for `.pulse` files of any size we can write: one 1 MiB chunk in memory at a time,
// read and written through expo-file-system's FileHandle. Entries are STORE (fflate's
// ZipPassThrough): the media is already compressed.
//
// Writing uses fflate's streaming `Zip`. Reading does NOT use fflate's streaming `Unzip`: `Zip`
// always writes sizes after the data (a data descriptor), so `Unzip` finds an entry's end by
// scanning its bytes for a ZIP signature, and a recording that happens to contain one is cut
// there (a real iPhone .MOV did: "unknown compression type"). The reader below takes every
// entry's offset and size from the central directory at the end of the file instead.
//
// Writing still computes each entry's CRC-32 in JS (fflate; the ZIP format requires it).
// Reading checks media against the native MD5 its manifest records instead of that CRC.

const CHUNK = 1 << 20;
/** fflate writes no ZIP64, so sizes and offsets must fit in 32 bits. */
const MAX_ZIP_BYTES = 0xffffffff;
export const TOO_BIG_TO_ZIP = 'This is more than a .pulse file can hold (4 GB).';
/** Far more than any `.pulse` file's entries need (each is ~100 bytes). */
const MAX_DIRECTORY_BYTES = 16 << 20;

export type ZipSource = { name: string; file: File } | { name: string; bytes: Uint8Array };

/** Write `sources` to `dest` as a STORE zip, streamed. */
export function writeZip(dest: File, sources: ZipSource[]): void {
  // Refuse before writing anything: the sizes are known up front (headers add a few KB).
  const total = sources.reduce(
    (sum, s) => sum + ('bytes' in s ? s.bytes.length : (s.file.size ?? 0)),
    0,
  );
  if (total > MAX_ZIP_BYTES) throw new Error(TOO_BIG_TO_ZIP);
  if (dest.exists) dest.delete();
  dest.create({ intermediates: true });
  const out = dest.open(FileMode.WriteOnly);
  let written = 0;
  let failure: unknown = null;
  const zip = new Zip((err, chunk) => {
    if (err) failure ??= err;
    else if ((written += chunk.length) > MAX_ZIP_BYTES) failure ??= new Error(TOO_BIG_TO_ZIP);
    else out.writeBytes(chunk);
  });
  try {
    for (const source of sources) {
      const entry = new ZipPassThrough(source.name);
      zip.add(entry);
      if ('bytes' in source) entry.push(source.bytes, true);
      else streamFile(source.file, (chunk, last) => entry.push(chunk, last));
      if (failure) throw failure;
    }
    zip.end();
    if (failure) throw failure;
  } finally {
    out.close();
  }
}

/** Feed a file to `push` in chunks; the last call has `last` set (an empty file gets one call). */
function streamFile(file: File, push: (chunk: Uint8Array, last: boolean) => void): void {
  const handle = file.open(FileMode.ReadOnly);
  try {
    const size = handle.size ?? 0;
    if (size === 0) push(new Uint8Array(0), true);
    for (let offset = 0; offset < size;) {
      const chunk = handle.readBytes(Math.min(CHUNK, size - offset));
      if (chunk.length === 0) throw new Error(`${file.name} ended early`);
      offset += chunk.length;
      push(chunk, offset >= size);
    }
  } finally {
    handle.close();
  }
}

export type ZipEntry = { name: string; size: number; crc: number; headerOffset: number };

function readAt(handle: FileHandle, offset: number, length: number): DataView {
  handle.offset = offset;
  const bytes = handle.readBytes(length);
  if (bytes.length !== length) throw new Error('The file ended early.');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The archive's entries by name, from its central directory. Only STORE entries are accepted. */
export function readZipIndex(handle: FileHandle): Map<string, ZipEntry> {
  const size = handle.size ?? 0;
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = readAt(handle, size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tailLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = tail.getUint16(eocd + 10, true);
  const dirSize = tail.getUint32(eocd + 12, true);
  const dirOffset = tail.getUint32(eocd + 16, true);
  // A crafted directory size would make this read (and allocate) up to the whole file.
  if (dirSize > MAX_DIRECTORY_BYTES || dirOffset + dirSize > size) {
    throw new Error('Damaged zip directory.');
  }
  const dir = readAt(handle, dirOffset, dirSize);
  const entries = new Map<string, ZipEntry>();
  for (let i = 0, p = 0; i < count; i++) {
    if (dir.getUint32(p, true) !== 0x02014b50) throw new Error('Damaged zip directory.');
    const method = dir.getUint16(p + 10, true);
    const nameLength = dir.getUint16(p + 28, true);
    const skip = nameLength + dir.getUint16(p + 30, true) + dir.getUint16(p + 32, true);
    const nameBytes = new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength);
    const name = strFromU8(nameBytes);
    if (method !== 0) throw new Error(`${name} is compressed; .pulse files store media as is.`);
    entries.set(name, {
      name,
      crc: dir.getUint32(p + 16, true),
      size: dir.getUint32(p + 24, true),
      headerOffset: dir.getUint32(p + 42, true),
    });
    p += 46 + skip;
  }
  return entries;
}

/** Where an entry's bytes start (after its local header, whose lengths can differ). */
function dataOffset(handle: FileHandle, entry: ZipEntry): number {
  const header = readAt(handle, entry.headerOffset, 30);
  if (header.getUint32(0, true) !== 0x04034b50) throw new Error('Damaged zip entry.');
  return entry.headerOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(crc: number, bytes: Uint8Array): number {
  let c = ~crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * Stream an entry into `dest` (replaced) and check it; a mismatch deletes `dest` and throws. With
 * `md5` (from the file's manifest) the written file is hashed natively and the JS CRC is skipped,
 * so media bytes are never hashed in JavaScript; without it (older files) the CRC is checked.
 */
export function extractEntry(handle: FileHandle, entry: ZipEntry, dest: File, md5?: string): void {
  if (dest.exists) dest.delete();
  dest.create({ intermediates: true });
  const out = dest.open(FileMode.WriteOnly);
  let crc = 0;
  try {
    const start = dataOffset(handle, entry);
    for (let done = 0; done < entry.size;) {
      handle.offset = start + done;
      const chunk = handle.readBytes(Math.min(CHUNK, entry.size - done));
      if (chunk.length === 0) throw new Error(`${entry.name} ended early.`);
      if (!md5) crc = crc32(crc, chunk);
      out.writeBytes(chunk);
      done += chunk.length;
    }
  } finally {
    out.close();
  }
  if (md5 ? nativeMd5(dest) !== md5 : crc !== entry.crc) {
    dest.delete();
    throw new Error(`${entry.name} is damaged.`);
  }
}

/** A small entry (a manifest) as text; refuses one over `max` bytes. */
export function readEntryText(handle: FileHandle, entry: ZipEntry, max = 64 << 20): string {
  if (entry.size > max) throw new Error(`${entry.name} is too large.`);
  handle.offset = dataOffset(handle, entry);
  const bytes = handle.readBytes(entry.size);
  if (bytes.length !== entry.size || crc32(0, bytes) !== entry.crc) {
    throw new Error(`${entry.name} is damaged.`);
  }
  return strFromU8(bytes);
}
