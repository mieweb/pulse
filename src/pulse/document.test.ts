import { describe, expect, it } from '@jest/globals';

import {
  emptyPulseState,
  parsePulseYaml,
  stringifyPulseYaml,
  validatePulseDocument,
  validatePulseState,
  type PulseDocument,
} from './document';

/** Every field of every table, including intentionally opaque legacy values. */
export function fullDocument(): PulseDocument {
  return {
    format: 'pulse-document',
    version: 2,
    scope: 'library',
    revision: 7,
    state: {
      drafts: [
        {
          id: 'draft-a',
          name: 'true: a name\nwith Unicode 🫀',
          uploadServer: 'https://vault.test/pv',
          uploadArtifactId: 'artifact-a',
          uploadStatus: 'uploaded',
          contextServer: 'https://vault.test/pv',
          contextRef: 'ref-a',
          mergedSignature: 'signature-a',
          mergedDurationMs: 1432.5,
          captionY: 0.37,
          lastClipNumber: 9,
          createdAt: 12,
          lastModified: 99,
        },
      ],
      segments: [
        {
          id: 'segment-a',
          draftId: 'draft-a',
          order: 3,
          label: 'custom badge',
          originalFilename: 'drafts/draft-a/segments/original.mov',
          durationMs: 2456.75,
          editedFilename: 'drafts/draft-a/segments/legacy.mp4',
          editedDurationMs: 1432.5,
          editState: 'not JSON — the baked file is authoritative',
          thumbnail: 'drafts/draft-a/segments/cover.jpg',
          captionEdit:
            '{"file":"drafts/draft-a/segments/legacy.mp4","words":[{"text":"corrected","t0":5,"t1":11,"start":true}]}',
        },
      ],
      draftTranscripts: [
        {
          draftId: 'draft-a',
          signature: 'old-signature',
          model: null,
          status: 'done',
          lines: '[]',
          editedLines: '[{"text":"manual legacy correction"}]',
          durationMs: 1432.5,
          createdAt: 17,
        },
      ],
      clipTranscripts: [
        {
          segmentId: 'segment-a',
          model: 'whisper-small',
          file: 'old/deleted/source.mov',
          status: 'done',
          words: '[{"text":"generated","t0":0,"t1":10}]',
          createdAt: 18,
        },
      ],
      settings: [
        { key: 'appearance.theme', value: 'dark' },
        { key: 'opaque.app-data', value: null },
      ],
      uploadDestinations: [
        {
          id: 'destination-a',
          server: 'https://vault.test/pv',
          artifactId: 'unclaimed-artifact',
          ref: 'another-ref',
          label: 'Team',
          app: 'Host',
          returnUrl: 'https://host.test/back',
          createdAt: 19,
        },
      ],
    },
    assets: [
      {
        path: 'drafts/draft-a/segments/original.mov',
        archivePath: 'assets/original',
        byteLength: 3,
        sha256: 'a'.repeat(64),
      },
      {
        path: 'drafts/draft-a/segments/legacy.mp4',
        archivePath: 'assets/legacy',
        byteLength: 4,
        sha256: 'b'.repeat(64),
      },
    ],
  };
}

describe('Pulse document YAML', () => {
  it('round-trips all 48 columns, original+baked assets, captions and settings without normalization', () => {
    const source = fullDocument();
    expect(parsePulseYaml(stringifyPulseYaml(source))).toEqual(source);
    expect(source.state.segments[0].editState).toBe('not JSON — the baked file is authoritative');
  });

  it('round-trips an empty library and literal-looking strings/null values', () => {
    const doc: PulseDocument = {
      format: 'pulse-document',
      version: 2,
      scope: 'library',
      revision: 0,
      state: emptyPulseState(),
      assets: [],
    };
    doc.state.settings = ['true', 'null', '01', '# comment', 'a: b', '---', ''].map((value, i) => ({
      key: String(i),
      value,
    }));
    expect(parsePulseYaml(stringifyPulseYaml(doc))).toEqual(doc);
  });

  it('rejects future versions and unknown/missing fields before accepting the document', () => {
    const doc = fullDocument();
    expect(() =>
      parsePulseYaml(stringifyPulseYaml(doc).replace('version: 2', 'version: 3')),
    ).toThrow('unsupported version');
    expect(() => validatePulseDocument({ ...doc, extra: 'cannot silently drop' })).toThrow(
      'unknown field extra',
    );
    const missing = fullDocument() as unknown as { state: { drafts: Record<string, unknown>[] } };
    delete missing.state.drafts[0].captionY;
    expect(() => validatePulseDocument(missing)).toThrow('missing field captionY');
  });

  it('rejects nonfinite values and invalid column types', () => {
    const doc = fullDocument();
    doc.state.drafts[0].createdAt = Infinity;
    expect(() => validatePulseDocument(doc)).toThrow('expected number');
    expect(() =>
      validatePulseState({ ...emptyPulseState(), settings: [{ key: 'x', value: true }] }),
    ).toThrow('expected string?');
  });

  it('rejects duplicate YAML keys and aliases', () => {
    const yaml = stringifyPulseYaml(fullDocument());
    expect(() => parsePulseYaml(`${yaml}\nversion: 2\n`)).toThrow('Invalid Pulse YAML');
    expect(() =>
      parsePulseYaml(
        yaml
          .replace('format: pulse-document', 'format: &format pulse-document')
          .replace('scope: library', 'scope: *format'),
      ),
    ).toThrow();
  });

  it('rejects broken foreign keys, duplicate IDs and duplicate segment slots', () => {
    const doc = fullDocument();
    doc.state.segments[0].draftId = 'missing';
    expect(() => validatePulseDocument(doc)).toThrow('missing draft');
    const duplicate = fullDocument();
    duplicate.state.segments.push({ ...duplicate.state.segments[0], id: 'other' });
    expect(() => validatePulseDocument(duplicate)).toThrow('duplicate key');
    const ids = fullDocument();
    ids.state.drafts.push({ ...ids.state.drafts[0] });
    expect(() => validatePulseDocument(ids)).toThrow('duplicate key');
  });

  it('requires originals and every baked file but allows missing derived thumbnails/exports', () => {
    const doc = fullDocument();
    expect(() => validatePulseDocument(doc)).not.toThrow();
    doc.assets.pop();
    expect(() => validatePulseDocument(doc)).toThrow('missing referenced media');
  });

  it.each(['../escape', '/absolute', 'file://uri', 'a\\b', 'a/./b', 'a//b', 'a/../b'])(
    'rejects unsafe asset path %s',
    (path) => {
      const doc = fullDocument();
      doc.assets[0].path = path;
      expect(() => validatePulseDocument(doc)).toThrow('unsafe relative path');
    },
  );

  it('allows content-addressed deduplication but rejects conflicting content for one entry', () => {
    const doc = fullDocument();
    doc.assets[1] = { ...doc.assets[0], path: doc.assets[1].path };
    expect(() => validatePulseDocument(doc)).not.toThrow();
    doc.assets[1].byteLength++;
    expect(() => validatePulseDocument(doc)).toThrow('different content');
  });
});
