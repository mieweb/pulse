// A Node stand-in for react-native-zip-archive, for Jest:
// `jest.mock('react-native-zip-archive', () => jest.requireActual('@/test-support/zip-archive-node'))`.
// It mirrors the native layout (RNZipArchive.mm `expandedZipEntries`, the same on Android): a listed
// file is stored under its base name; a listed folder adds its contents relative to itself.
import { unzipSync, zipSync } from 'fflate';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

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

export async function unzip(source: string, target: string) {
  for (const [name, bytes] of Object.entries(unzipSync(readFileSync(source)))) {
    if (name.endsWith('/')) continue;
    const dest = join(target, name);
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
