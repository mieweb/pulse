import { describe, expect, it } from '@jest/globals';

import { PAGE_16K, pageCheck, parseElf } from './android-elf.mjs';

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_GNU_RELRO = 0x6474e552;

type Seg = { type: number; offset?: number; vaddr: number; memsz: number; align: number };

/**
 * A minimal little-endian ELF: the header, then the program headers right after it. Each
 * segment's flags field is set to 0x7 (RWX bits), so a parser reading flags as p_align gets 7.
 */
function elf(elfClass: 32 | 64, machine: number, segs: Seg[]): Buffer {
  const is64 = elfClass === 64;
  const ehsize = is64 ? 64 : 52;
  const phentsize = is64 ? 56 : 32;
  const buf = Buffer.alloc(ehsize + segs.length * phentsize);
  buf.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, 1, 1], 0);
  buf.writeUInt16LE(3, 16); // ET_DYN
  buf.writeUInt16LE(machine, 18);
  buf.writeUInt32LE(1, 20);
  if (is64) {
    buf.writeBigUInt64LE(BigInt(ehsize), 32);
    buf.writeUInt16LE(ehsize, 52);
    buf.writeUInt16LE(phentsize, 54);
    buf.writeUInt16LE(segs.length, 56);
  } else {
    buf.writeUInt32LE(ehsize, 28);
    buf.writeUInt16LE(ehsize, 40);
    buf.writeUInt16LE(phentsize, 42);
    buf.writeUInt16LE(segs.length, 44);
  }
  segs.forEach((s, i) => {
    const at = ehsize + i * phentsize;
    buf.writeUInt32LE(s.type, at);
    if (is64) {
      buf.writeUInt32LE(7, at + 4);
      buf.writeBigUInt64LE(BigInt(s.offset ?? 0), at + 8);
      buf.writeBigUInt64LE(BigInt(s.vaddr), at + 16);
      buf.writeBigUInt64LE(BigInt(s.vaddr), at + 24);
      buf.writeBigUInt64LE(BigInt(s.memsz), at + 32);
      buf.writeBigUInt64LE(BigInt(s.memsz), at + 40);
      buf.writeBigUInt64LE(BigInt(s.align), at + 48);
    } else {
      buf.writeUInt32LE(s.offset ?? 0, at + 4);
      buf.writeUInt32LE(s.vaddr, at + 8);
      buf.writeUInt32LE(s.vaddr, at + 12);
      buf.writeUInt32LE(s.memsz, at + 16);
      buf.writeUInt32LE(s.memsz, at + 20);
      buf.writeUInt32LE(7, at + 24);
      buf.writeUInt32LE(s.align, at + 28);
    }
  });
  return buf;
}

const AARCH64 = 183;
const ARM = 40;

describe('parseElf', () => {
  it('reads an ELF64 library: class, machine, LOAD segments and the RELRO range', () => {
    const info = parseElf(
      elf(64, AARCH64, [
        { type: PT_LOAD, vaddr: 0, memsz: 0x5000, align: PAGE_16K },
        { type: PT_LOAD, offset: 0x8000, vaddr: 0x8000, memsz: 0x2000, align: PAGE_16K },
        { type: PT_DYNAMIC, vaddr: 0x9000, memsz: 0x100, align: 8 },
        { type: PT_GNU_RELRO, vaddr: 0x8000, memsz: 0x1800, align: 1 },
      ]),
    );
    expect(info.elfClass).toBe(64);
    expect(info.machineName).toBe('aarch64');
    expect(info.loads.map((s) => [s.vaddr, s.memsz, s.align])).toEqual([
      [0, 0x5000, PAGE_16K],
      [0x8000, 0x2000, PAGE_16K],
    ]);
    expect(info.loads[1].offset).toBe(0x8000);
    expect(info.relro).toEqual({ start: 0x8000, end: 0x9800 });
  });

  it('reads an ELF32 library, where p_flags sits before p_align', () => {
    const info = parseElf(
      elf(32, ARM, [
        { type: PT_LOAD, vaddr: 0, memsz: 0x3000, align: 0x1000 },
        { type: PT_LOAD, vaddr: 0x4000, memsz: 0x1000, align: 0x1000 },
      ]),
    );
    expect(info.elfClass).toBe(32);
    expect(info.machineName).toBe('arm');
    expect(info.loads.map((s) => s.align)).toEqual([0x1000, 0x1000]);
    expect(info.loads[1].vaddr).toBe(0x4000);
    expect(info.relro).toBeNull();
  });

  it('refuses a file cut short before its last program header', () => {
    const whole = elf(64, AARCH64, [
      { type: PT_LOAD, vaddr: 0, memsz: 0x1000, align: PAGE_16K },
      { type: PT_LOAD, vaddr: 0x4000, memsz: 0x1000, align: PAGE_16K },
    ]);
    expect(() => parseElf(whole.subarray(0, whole.length - 8), 'libcut.so')).toThrow(
      /libcut\.so: truncated ELF \(the program headers/,
    );
    expect(() => parseElf(whole.subarray(0, 40), 'libcut.so')).toThrow(/truncated ELF/);
  });

  it('refuses what is not a little-endian ELF file', () => {
    expect(() => parseElf(Buffer.from('not an elf file at all'))).toThrow(/not an ELF file/);
    const bigEndian = elf(64, AARCH64, []);
    bigEndian[5] = 2;
    expect(() => parseElf(bigEndian)).toThrow(/not a little-endian/);
  });
});

describe('pageCheck', () => {
  it('passes a library whose every LOAD segment is 16 KB aligned, and reports RELRO alignment', () => {
    const aligned = pageCheck(
      parseElf(
        elf(64, AARCH64, [
          { type: PT_LOAD, vaddr: 0, memsz: 0x5000, align: PAGE_16K },
          { type: PT_LOAD, vaddr: 0x8000, memsz: 0x4000, align: 0x10000 },
          { type: PT_GNU_RELRO, vaddr: 0x8000, memsz: 0x4000, align: 1 },
        ]),
      ),
    );
    expect(aligned).toEqual({ aligned: true, minAlign: PAGE_16K, relroEndAligned: true });
  });

  it('fails a library with a 4 KB aligned LOAD segment', () => {
    const check = pageCheck(
      parseElf(
        elf(64, AARCH64, [
          { type: PT_LOAD, vaddr: 0, memsz: 0x5000, align: PAGE_16K },
          { type: PT_LOAD, vaddr: 0x6000, memsz: 0x1000, align: 0x1000 },
          { type: PT_GNU_RELRO, vaddr: 0x6000, memsz: 0x800, align: 1 },
        ]),
      ),
    );
    expect(check).toEqual({ aligned: false, minAlign: 0x1000, relroEndAligned: false });
  });

  it('fails a library with no LOAD segment, and has no RELRO answer without a RELRO segment', () => {
    expect(pageCheck(parseElf(elf(64, AARCH64, [])))).toEqual({
      aligned: false,
      minAlign: null,
      relroEndAligned: null,
    });
  });
});
