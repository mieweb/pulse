// @ts-check
// ELF headers of the native libraries in a PulseKit AAR (G5). Google Play requires every 64-bit
// `.so` of an app targeting Android 15+ to load on 16 KB pages: each PT_LOAD segment's p_align
// must be at least 16384. package-android.mjs reads the program headers here instead of running
// `llvm-readelf`, so the check needs no NDK on the machine that packages.

import { Buffer } from 'node:buffer';

/** Play's page size for 64-bit libraries. */
export const PAGE_16K = 16384;

const PT_LOAD = 1;
const PT_GNU_RELRO = 0x6474e552;

/** e_machine values Android ships. */
const MACHINES = /** @type {Record<number, string>} */ ({
  3: 'x86',
  40: 'arm',
  62: 'x86_64',
  183: 'aarch64',
});

/**
 * @typedef {object} ElfSegment
 * @property {number} offset  p_offset
 * @property {number} vaddr   p_vaddr
 * @property {number} filesz  p_filesz
 * @property {number} memsz   p_memsz
 * @property {number} align   p_align
 */

/**
 * @typedef {object} ElfInfo
 * @property {32 | 64} elfClass
 * @property {number} machine      e_machine
 * @property {string} machineName  'aarch64', 'arm', 'x86_64', 'x86', or `machine <n>`
 * @property {ElfSegment[]} loads  The PT_LOAD segments, in file order.
 * @property {{ start: number, end: number } | null} relro  PT_GNU_RELRO's [vaddr, vaddr + memsz).
 */

/**
 * Reads a little-endian ELF file's header and program headers. Throws on anything that isn't
 * one, including a file cut short before its last program header.
 * @param {Uint8Array} bytes
 * @param {string} [label]  Names the file in errors.
 * @returns {ElfInfo}
 */
export function parseElf(bytes, label = 'file') {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (/** @type {number} */ end, /** @type {string} */ what) => {
    if (end > buf.length) {
      throw new Error(`${label}: truncated ELF (${what} ends at ${end}, file is ${buf.length})`);
    }
  };
  need(16, 'e_ident');
  if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    throw new Error(`${label}: not an ELF file`);
  }
  const elfClass = buf[4] === 1 ? 32 : buf[4] === 2 ? 64 : null;
  if (elfClass === null) throw new Error(`${label}: unknown ELF class ${buf[4]}`);
  if (buf[5] !== 1) throw new Error(`${label}: not a little-endian ELF file`);

  const is64 = elfClass === 64;
  need(is64 ? 64 : 52, 'the ELF header');
  /** A 64-bit field as a Number; ELF sizes and addresses in a .so fit in 2^53. */
  const u64 = (/** @type {number} */ at) => {
    const v = buf.readBigUInt64LE(at);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}: field at ${at} too large`);
    return Number(v);
  };
  const word = (/** @type {number} */ at) => (is64 ? u64(at) : buf.readUInt32LE(at));

  const machine = buf.readUInt16LE(18);
  const phoff = word(is64 ? 32 : 28);
  const phentsize = buf.readUInt16LE(is64 ? 54 : 42);
  const phnum = buf.readUInt16LE(is64 ? 56 : 44);
  const minEntry = is64 ? 56 : 32;
  if (phnum > 0 && phentsize < minEntry) {
    throw new Error(`${label}: program header entries of ${phentsize} bytes (need ${minEntry})`);
  }
  need(phoff + phnum * phentsize, 'the program headers');

  /** @type {ElfSegment[]} */
  const loads = [];
  /** @type {{ start: number, end: number } | null} */
  let relro = null;
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize;
    const type = buf.readUInt32LE(at);
    // ELF64: type, flags, offset, vaddr, paddr, filesz, memsz, align (flags second).
    // ELF32: type, offset, vaddr, paddr, filesz, memsz, flags, align (flags seventh).
    const seg = is64
      ? {
          offset: u64(at + 8),
          vaddr: u64(at + 16),
          filesz: u64(at + 32),
          memsz: u64(at + 40),
          align: u64(at + 48),
        }
      : {
          offset: buf.readUInt32LE(at + 4),
          vaddr: buf.readUInt32LE(at + 8),
          filesz: buf.readUInt32LE(at + 16),
          memsz: buf.readUInt32LE(at + 20),
          align: buf.readUInt32LE(at + 28),
        };
    if (type === PT_LOAD) loads.push(seg);
    else if (type === PT_GNU_RELRO) relro = { start: seg.vaddr, end: seg.vaddr + seg.memsz };
  }
  return {
    elfClass,
    machine,
    machineName: MACHINES[machine] ?? `machine ${machine}`,
    loads,
    relro,
  };
}

/**
 * @typedef {object} PageCheck
 * @property {boolean} aligned      Every PT_LOAD has p_align >= 16384.
 * @property {number | null} minAlign  The smallest PT_LOAD p_align (null: no PT_LOAD).
 * @property {boolean | null} relroEndAligned  Whether PT_GNU_RELRO ends on a 16 KB boundary
 *   (null: no RELRO segment). Reported, not required: Play's check reads p_align only, but a
 *   RELRO end inside a 16 KB page leaves the rest of that page writable after relocation.
 */

/**
 * The 16 KB page check for one library.
 * @param {ElfInfo} elf
 * @returns {PageCheck}
 */
export function pageCheck(elf) {
  const aligns = elf.loads.map((s) => s.align);
  const minAlign = aligns.length > 0 ? Math.min(...aligns) : null;
  return {
    aligned: minAlign !== null && minAlign >= PAGE_16K,
    minAlign,
    relroEndAligned: elf.relro === null ? null : elf.relro.end % PAGE_16K === 0,
  };
}
