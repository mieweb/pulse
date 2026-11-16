import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { Unzip, UnzipPassThrough } from 'fflate';
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { File, FileHandle, FileMode } from '@/test-support/expo-fs-node';
import { extractEntry, readZipIndex, writeZip } from './zip-stream';

jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));

const DIR = mkdtempSync(join(process.env.PULSE_ZIP_TMP ?? tmpdir(), 'pulse-zip-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

/** Bytes with a ZIP local-header signature in the middle, as a recording can happen to have. */
function withSignature(): Uint8Array {
  const bytes = new Uint8Array(3 << 20).map((_, i) => (i * 7) & 0xff);
  bytes.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0], 1 << 20);
  return bytes;
}

describe('streamed .pulse zip', () => {
  it('fflate’s streaming Unzip cuts an entry at a signature inside its data; the central-directory reader does not', () => {
    const src = new File(DIR, 'clip.mp4');
    src.write(withSignature());
    const zip = new File(DIR, 'a.pulse');
    writeZip(zip as never, [{ name: 'media/clip.mp4', file: src as never }]);

    // fflate's Unzip over the same bytes: the entry ends early or the stream errors.
    const seen: { name: string; bytes: number }[] = [];
    let error: unknown = null;
    const unzip = new Unzip((f) => {
      const e = { name: f.name, bytes: 0 };
      seen.push(e);
      f.ondata = (err, d) => {
        if (err) error = err;
        else e.bytes += d.length;
      };
      f.start();
    });
    unzip.register(UnzipPassThrough);
    try {
      unzip.push(readFileSync(zip.path), true);
    } catch (e) {
      error = e;
    }
    console.log(
      '[fflate Unzip]',
      error ? String(error) : JSON.stringify(seen),
      'expected',
      src.size,
    );
    expect(error !== null || seen[0].bytes !== src.size).toBe(true);

    // Ours: exact bytes, CRC checked.
    const handle = zip.open(FileMode.ReadOnly);
    const entry = readZipIndex(handle as never).get('media/clip.mp4')!;
    const out = new File(DIR, 'out.mp4');
    extractEntry(handle as never, entry, out as never);
    handle.close();
    expect(Buffer.compare(readFileSync(out.path), readFileSync(src.path))).toBe(0);
  });

  it('rejects a damaged entry (CRC mismatch) and leaves no partial file', () => {
    const src = new File(DIR, 'b.mp4');
    src.write(new Uint8Array(100_000).fill(7));
    const zip = new File(DIR, 'b.pulse');
    writeZip(zip as never, [{ name: 'b.mp4', file: src as never }]);
    const bytes = readFileSync(zip.path);
    bytes[200] ^= 0xff; // inside the data
    new File(DIR, 'b2.pulse').write(bytes);
    const handle = new File(DIR, 'b2.pulse').open(FileMode.ReadOnly);
    const out = new File(DIR, 'b-out.mp4');
    expect(() =>
      extractEntry(handle as never, readZipIndex(handle as never).get('b.mp4')!, out as never),
    ).toThrow('b.mp4 is damaged.');
    handle.close();
    expect(out.exists).toBe(false);
  });

  // PULSE_BIG_ZIP=<MiB> runs it (e.g. 500); it writes the zip and the extracted copy to disk.
  const bigMiB = Number(process.env.PULSE_BIG_ZIP ?? 0);
  (bigMiB > 0 ? it : it.skip)(
    `round-trips a ${bigMiB} MiB file with flat memory`,
    () => {
      const size = bigMiB << 20;
      const src = new File(DIR, 'big.mp4');
      const fd = openSync(src.path, 'w');
      ftruncateSync(fd, size); // sparse source: no disk for the input
      closeSync(fd);

      // Sample memory on every chunk read, through the fake FileHandle. (Not jest.spyOn: a mock
      // keeps every return value — every chunk — which is itself a 1:1 leak.)
      let peak = 0;
      let peakBuffers = 0;
      const read = FileHandle.prototype.readBytes;
      FileHandle.prototype.readBytes = function (this: FileHandle, n: number) {
        const m = process.memoryUsage();
        peak = Math.max(peak, m.rss);
        peakBuffers = Math.max(peakBuffers, m.arrayBuffers);
        return read.call(this, n);
      };
      const gc = (global as { gc?: () => void }).gc;
      gc?.();
      const startRss = process.memoryUsage().rss;
      const t0 = Date.now();
      const zip = new File(DIR, 'big.pulse');
      writeZip(zip as never, [{ name: 'media/big.mp4', file: src as never }]);
      const tZip = Date.now() - t0;
      const handle = zip.open(FileMode.ReadOnly);
      const entry = readZipIndex(handle as never).get('media/big.mp4')!;
      const out = new File(DIR, 'big-out.mp4');
      const t1 = Date.now();
      extractEntry(handle as never, entry, out as never);
      const tUnzip = Date.now() - t1;
      handle.close();
      FileHandle.prototype.readBytes = read;
      gc?.();
      const retained = process.memoryUsage().arrayBuffers;
      const MiB = (b: number) => Math.round(b / 1048576);
      console.log(
        `[big zip] ${bigMiB} MiB: zip ${MiB(statSync(zip.path).size)} MiB in ${tZip} ms, extract in ${tUnzip} ms; ` +
          `RSS start ${MiB(startRss)} MiB, peak ${MiB(peak)} MiB (+${MiB(peak - startRss)} MiB), ` +
          `peak ArrayBuffers ${MiB(peakBuffers)} MiB, after GC ${gc ? MiB(retained) + ' MiB' : 'n/a (no --expose-gc)'}`,
      );
      expect(out.size).toBe(size);
      // Chunks are garbage the moment they're written: the peak is GC lag, not the file size.
      expect(peak - startRss).toBeLessThan(Math.min(size / 2, 200 << 20));
      if (gc) expect(retained).toBeLessThan(8 << 20);
      rmSync(zip.path);
      rmSync(out.path);
      rmSync(src.path);
    },
    600_000,
  );
});
