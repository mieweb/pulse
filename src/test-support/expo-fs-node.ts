// A Node-fs stand-in for the parts of expo-file-system the persistence code uses, for Jest:
// `jest.mock('expo-file-system', () => require('@/test-support/expo-fs-node'))`. Folders come
// from `env`, which a test points at a temp dir (one per "device").
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

/** `availableDiskSpace` is what `Paths.availableDiskSpace` reports (a test lowers it). */
export const env = { docDir: '', cacheDir: '', dbDir: '', availableDiskSpace: Infinity };

/** Every file `info({ md5: true })` hashed, so a test can see what was hashed (natively, on a phone). */
export const md5Calls: string[] = [];

type Part = string | File | Directory;
const toPath = (p: Part): string =>
  typeof p === 'string' ? decodeURIComponent(p.replace(/^file:\/\//, '')) : p.path;
const joinParts = (parts: Part[]) => join(...parts.map(toPath));

export enum FileMode {
  ReadWrite = 'rw',
  ReadOnly = 'r',
  WriteOnly = 'w',
  Append = 'wa',
  Truncate = 'wt',
}
const FLAGS: Record<FileMode, string> = { rw: 'r+', r: 'r', w: 'r+', wa: 'a', wt: 'w' };

export class FileHandle {
  offset: number | null = 0;
  constructor(private fd: number) {}
  get size() {
    return fstatSync(this.fd).size;
  }
  readBytes(length: number): Uint8Array {
    const buf = new Uint8Array(length);
    const n = readSync(this.fd, buf, 0, length, this.offset ?? 0);
    this.offset = (this.offset ?? 0) + n;
    return buf.subarray(0, n);
  }
  writeBytes(bytes: Uint8Array) {
    writeSync(this.fd, bytes, 0, bytes.length, this.offset ?? 0);
    this.offset = (this.offset ?? 0) + bytes.length;
  }
  close() {
    closeSync(this.fd);
  }
}

export class File {
  path: string;
  constructor(...parts: Part[]) {
    this.path = joinParts(parts);
  }
  get uri() {
    return `file://${this.path}`;
  }
  get name() {
    return basename(this.path);
  }
  get exists() {
    return existsSync(this.path) && statSync(this.path).isFile();
  }
  get size() {
    return this.exists ? statSync(this.path).size : 0;
  }
  get parentDirectory() {
    return new Directory(dirname(this.path));
  }
  create(opts: { intermediates?: boolean; overwrite?: boolean } = {}) {
    if (opts.intermediates) mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, '', { flag: opts.overwrite ? 'w' : 'wx' });
  }
  delete() {
    rmSync(this.path);
  }
  async copy(dest: File) {
    copyFileSync(this.path, dest.path);
  }
  copySync(dest: File) {
    copyFileSync(this.path, dest.path);
  }
  async move(dest: File) {
    this.moveSync(dest);
  }
  moveSync(dest: File) {
    renameSync(this.path, dest.path);
    this.path = dest.path; // expo's move points the File at its new place
  }
  textSync() {
    return readFileSync(this.path, 'utf8');
  }
  bytesSync() {
    return new Uint8Array(readFileSync(this.path));
  }
  async bytes() {
    return this.bytesSync();
  }
  write(content: string | Uint8Array, opts: { append?: boolean } = {}) {
    (opts.append ? appendFileSync : writeFileSync)(this.path, content);
  }
  open(mode: FileMode = FileMode.ReadWrite) {
    return new FileHandle(openSync(this.path, FLAGS[mode]));
  }
  info(opts: { md5?: boolean } = {}) {
    if (!this.exists) return { exists: false };
    const info: { exists: true; size: number; md5?: string } = { exists: true, size: this.size };
    if (opts.md5) {
      md5Calls.push(this.path);
      info.md5 = createHash('md5').update(readFileSync(this.path)).digest('hex');
    }
    return info;
  }
}

export class Directory {
  path: string;
  constructor(...parts: Part[]) {
    this.path = joinParts(parts);
  }
  get uri() {
    return `file://${this.path}/`;
  }
  get name() {
    return basename(this.path);
  }
  get exists() {
    return existsSync(this.path) && statSync(this.path).isDirectory();
  }
  create(opts: { intermediates?: boolean; idempotent?: boolean } = {}) {
    if (this.exists && opts.idempotent) return;
    mkdirSync(this.path, { recursive: !!opts.intermediates });
  }
  delete() {
    rmSync(this.path, { recursive: true });
  }
  list(): (File | Directory)[] {
    return readdirSync(this.path, { withFileTypes: true }).map((e) =>
      e.isDirectory() ? new Directory(this.path, e.name) : new File(this.path, e.name),
    );
  }
}

export const Paths = {
  get document() {
    return new Directory(env.docDir);
  },
  get cache() {
    return new Directory(env.cacheDir);
  },
  get availableDiskSpace() {
    return env.availableDiskSpace;
  },
};
