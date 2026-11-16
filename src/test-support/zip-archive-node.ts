// A Node stand-in for react-native-zip-archive, for Jest:
// `jest.mock('react-native-zip-archive', () => jest.requireActual('@/test-support/zip-archive-node'))`.
// It mirrors the native layout (RNZipArchive.mm `expandedZipEntries`, the same on Android): a listed
// file is stored under its base name; a listed folder adds its contents relative to itself.
// Known differences, none of which the persistence code depends on: entries are always STORE
// (Android writes DEFLATE at level 0), no directory entries are written, `listContents` reports the
// real sizes rather than the header's, and duplicate names collapse into one.
import { unzipSync, zipSync } from 'fflate';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

function walk(dir: string, base = dir): [string, string][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e): [string, string][] => {
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [[full, relative(base, full)]];
  });
}

export async function zip(source: string | string[], target: string, _options?: unknown) {
  const files: Record<string, Uint8Array> = {};
  for (const path of Array.isArray(source) ? source : [source]) {
    if (statSync(path).isDirectory()) {
      for (const [full, rel] of walk(path)) files[rel] = readFileSync(full);
    } else {
      files[basename(path)] = readFileSync(path);
    }
  }
  writeFileSync(target, zipSync(files, { level: 0 }));
  return target;
}

/** Like native unzip (iOS `isSafeExtractPath`, Android `validateExtractPath`): no escaping entries. */
export async function unzip(source: string, target: string) {
  const root = resolve(target);
  for (const [name, bytes] of Object.entries(unzipSync(readFileSync(source)))) {
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) continue;
    const dest = resolve(root, name);
    if (dest !== root && !dest.startsWith(root + sep)) {
      throw Object.assign(new Error(`Unsafe entry path: ${name}`), { code: 'ERR_UNSAFE_PATH' });
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
  }
  return target;
}

export async function listContents(source: string) {
  return Object.entries(unzipSync(readFileSync(source))).map(([path, bytes]) => ({
    path,
    size: bytes.length,
    compressedSize: bytes.length,
    isDirectory: path.endsWith('/'),
    isEncrypted: false,
  }));
}
