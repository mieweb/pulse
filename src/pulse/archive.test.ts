import { describe, expect, it } from '@jest/globals';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import {
  decodePulseArchive,
  encodePulseArchive,
  pulseAssetSha256,
  readPulseArchiveEntries,
} from './archive';
import { emptyPulseState, type PulseDocument } from './document';

function fixture() {
  const bytes = new Uint8Array([0, 255, 1, 2, 3]);
  const hash = pulseAssetSha256(bytes);
  const document: PulseDocument = {
    format: 'pulse-document',
    version: 2,
    scope: 'library',
    revision: 14,
    state: emptyPulseState(),
    assets: [
      {
        path: 'drafts/a/original.mov',
        archivePath: `assets/${hash}`,
        byteLength: bytes.byteLength,
        sha256: hash,
      },
      {
        path: 'drafts/b/shared.mov',
        archivePath: `assets/${hash}`,
        byteLength: bytes.byteLength,
        sha256: hash,
      },
    ],
  };
  document.state.settings.push({ key: 'app-data', value: 'Unicode 🫀 中文\nsecond line' });
  return { document, bytes, assets: new Map(document.assets.map((a) => [a.path, bytes])) };
}

describe('Pulse v2 archive', () => {
  it('stores pulse.yaml and exact original bytes, deduplicating shared content', () => {
    const { document, assets, bytes } = fixture();
    const encoded = encodePulseArchive(document, assets);
    const entries = unzipSync(encoded);
    expect(Object.keys(entries)).toHaveLength(3);
    expect(strFromU8(entries['pulse.yaml'])).toContain('format: pulse-document');
    const decoded = decodePulseArchive(encoded);
    expect(decoded.document).toEqual(document);
    expect([...decoded.assets.keys()]).toEqual([...assets.keys()]);
    for (const value of decoded.assets.values()) expect(value).toEqual(bytes);
  });

  it('fails missing or changed media before producing an archive', () => {
    const { document, assets } = fixture();
    assets.delete(document.assets[0].path);
    expect(() => encodePulseArchive(document, assets)).toThrow('missing media');
    assets.set(document.assets[0].path, new Uint8Array([0, 255, 1, 2, 4]));
    expect(() => encodePulseArchive(document, assets)).toThrow('checksum mismatch');
  });

  it('detects corrupted payloads, missing entries and undocumented extra entries', () => {
    const { document, assets } = fixture();
    const entries = unzipSync(encodePulseArchive(document, assets));
    const path = document.assets[0].archivePath;
    entries[path] = new Uint8Array([0, 255, 1, 2, 4]);
    expect(() => decodePulseArchive(zipSync(entries))).toThrow('checksum mismatch');
    delete entries[path];
    expect(() => decodePulseArchive(zipSync(entries))).toThrow('missing media');
    entries[path] = assets.get(document.assets[0].path)!;
    entries['ignored-user-data'] = new Uint8Array([7]);
    expect(() => decodePulseArchive(zipSync(entries))).toThrow('absent from document');
  });

  it('applies size limits in both directions, including encoded ZIP overhead', () => {
    const { document, assets } = fixture();
    expect(() => encodePulseArchive(document, assets, { maxBytes: 1 })).toThrow('too large');
    const encoded = encodePulseArchive(document, assets);
    expect(() => decodePulseArchive(encoded, { maxBytes: encoded.byteLength - 1 })).toThrow(
      'too large',
    );
    const bomb = zipSync({ padding: new Uint8Array(10000) }, { level: 9 });
    expect(() => readPulseArchiveEntries(bomb, { maxBytes: 1000 })).toThrow('expands beyond');
  });

  it('rejects unsafe ZIP members and duplicate entries instead of overwriting them', () => {
    expect(() => readPulseArchiveEntries(zipSync({ '../escape': new Uint8Array([1]) }))).toThrow(
      'Unsafe',
    );
    const duplicate = zipSync({ x: new Uint8Array([1]), y: new Uint8Array([2]) }, { level: 0 });
    // Member names are one-byte ASCII in local headers and central-directory records.
    for (let i = 0; i < duplicate.length; i++) if (duplicate[i] === 121) duplicate[i] = 120;
    expect(() => readPulseArchiveEntries(duplicate)).toThrow('Duplicate');
  });

  it('rejects unknown YAML versions and does not mistake a legacy manifest for exact restore', () => {
    const { document, assets } = fixture();
    const entries = unzipSync(encodePulseArchive(document, assets));
    entries['pulse.yaml'] = strToU8(
      strFromU8(entries['pulse.yaml']).replace('version: 2', 'version: 3'),
    );
    entries['pulse.sha256'] = strToU8(pulseAssetSha256(entries['pulse.yaml']));
    expect(() => decodePulseArchive(zipSync(entries))).toThrow('unsupported version');
    expect(() =>
      decodePulseArchive(zipSync({ 'manifest.json': strToU8('{"version":1}') })),
    ).toThrow('legacy v1');
  });

  it('verifies YAML integrity before accepting plausible altered values', () => {
    const { document, assets } = fixture();
    const entries = unzipSync(encodePulseArchive(document, assets));
    entries['pulse.yaml'] = strToU8(
      strFromU8(entries['pulse.yaml']).replace('revision: 14', 'revision: 15'),
    );
    expect(() => decodePulseArchive(zipSync(entries))).toThrow('document checksum mismatch');
    delete entries['pulse.sha256'];
    expect(() => decodePulseArchive(zipSync(entries))).toThrow('document checksum mismatch');
  });
});
