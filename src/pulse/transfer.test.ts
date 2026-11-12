import { describe, expect, it } from '@jest/globals';

import { emptyPulseState, type PulseDocument } from './document';
import { copyPulseDrafts, selectPulseDrafts } from './transfer';

function fixture(): PulseDocument {
  const state = emptyPulseState();
  state.drafts.push({
    id: 'd1',
    name: 'Renamed',
    uploadServer: 'foreign-server',
    uploadArtifactId: 'artifact',
    uploadStatus: 'uploaded',
    contextServer: 'foreign-server',
    contextRef: 'visit',
    mergedSignature: 'old-merge',
    mergedDurationMs: 12.5,
    captionY: 0.37,
    lastClipNumber: 12,
    createdAt: 3,
    lastModified: 5,
  });
  state.drafts.push({ ...state.drafts[0], id: 'empty' });
  state.segments.push({
    id: 's1',
    draftId: 'd1',
    order: 8,
    label: 'my label',
    originalFilename: 'drafts/d1/source.mov',
    durationMs: 33.75,
    editedFilename: 'drafts/d1/baked.mp4',
    editedDurationMs: 12.5,
    editState: 'invalid legacy settings',
    thumbnail: 'drafts/d1/missing.jpg',
    captionEdit: '{"file":"drafts/d1/baked.mp4","words":[],"unknown":true}',
  });
  state.segments.push({
    ...state.segments[0],
    id: 's2',
    order: 2,
    captionEdit: 'invalid legacy correction',
  });
  state.draftTranscripts.push({
    draftId: 'd1',
    signature: '3|drafts/d1/baked.mp4|drafts/d1/baked.mp4',
    model: 'tiny',
    status: 'done',
    lines: '["generated"]',
    editedLines: '[]',
    durationMs: 25,
    createdAt: 4,
  });
  state.clipTranscripts.push({
    segmentId: 's1',
    model: 'tiny',
    file: 'drafts/d1/baked.mp4',
    status: 'done',
    words: '[{"t0":1,"t1":2,"text":"word"}]',
    createdAt: 4,
  });
  state.clipTranscripts.push({
    ...state.clipTranscripts[0],
    segmentId: 's2',
    file: 'old/missing.mov',
  });
  state.settings.push({ key: 'theme', value: 'foreign-theme' });
  state.uploadDestinations.push({
    id: 'foreign-destination',
    server: 'foreign-server',
    artifactId: 'artifact',
    ref: 'visit',
    label: 'Team',
    app: 'host',
    returnUrl: 'app://back',
    createdAt: 5,
  });
  return {
    format: 'pulse-document',
    version: 2,
    scope: 'library',
    revision: 9,
    state,
    assets: ['drafts/d1/source.mov', 'drafts/d1/baked.mp4', 'drafts/other/unrelated.mov'].map(
      (path, i) => ({
        path,
        archivePath: `assets/${i}`,
        byteLength: i,
        sha256: String(i).repeat(64),
      }),
    ),
  };
}

describe('Pulse selection and explicit copy policy', () => {
  it('preserves empty drafts, every project row and all global metadata in selection archives', () => {
    const source = fixture();
    const selected = selectPulseDrafts(source, ['d1', 'empty']);
    expect(selected.scope).toBe('selection');
    expect(selected.state).toEqual(source.state);
    expect(selected.assets.map((asset) => asset.path)).toEqual([
      'drafts/d1/source.mov',
      'drafts/d1/baked.mp4',
    ]);
    expect(() => selectPulseDrafts(source, ['missing'])).toThrow('Draft is missing');
    selected.state.drafts[0].name = 'changed';
    expect(source.state.drafts[0].name).toBe('Renamed');
  });

  it('copies both original and baked selections, shared references, history, corrections and transcript timing', () => {
    const source = fixture();
    source.assets.pop();
    const current = emptyPulseState();
    current.settings.push({ key: 'theme', value: 'local-theme' });
    current.uploadDestinations.push({ ...source.state.uploadDestinations[0], id: 'local' });
    let id = 0;
    const copy = copyPulseDrafts(current, source, 'imports/import-1', () => `new-${++id}`);
    expect(copy.draftIds).toEqual(['new-1', 'new-2']);
    expect(copy.mediaPaths.size).toBe(2);
    expect(copy.state.settings).toEqual(current.settings);
    expect(copy.state.uploadDestinations).toEqual(current.uploadDestinations);
    const draft = copy.state.drafts[0];
    expect(draft).toEqual({
      ...source.state.drafts[0],
      id: 'new-1',
      uploadServer: null,
      uploadArtifactId: null,
      uploadStatus: null,
      contextServer: null,
      contextRef: null,
      mergedSignature: null,
      mergedDurationMs: null,
    });
    const clip = copy.state.segments[0];
    expect(clip.editState).toBe('invalid legacy settings');
    expect(clip.originalFilename).toBe('imports/import-1/drafts/d1/source.mov');
    expect(clip.editedFilename).toBe('imports/import-1/drafts/d1/baked.mp4');
    expect(copy.state.segments[1].originalFilename).toBe(clip.originalFilename);
    expect(clip.label).toBe('my label');
    expect(clip.order).toBe(8);
    expect(JSON.parse(clip.captionEdit!)).toEqual({
      file: clip.editedFilename,
      words: [],
      unknown: true,
    });
    expect(copy.state.segments[1].captionEdit).toBe('invalid legacy correction');
    expect(copy.state.draftTranscripts[0]).toEqual({
      ...source.state.draftTranscripts[0],
      draftId: 'new-1',
      signature: `3|${clip.editedFilename}|${clip.editedFilename}`,
    });
    expect(copy.state.clipTranscripts[0].words).toBe(source.state.clipTranscripts[0].words);
    expect(copy.state.clipTranscripts[1].file).toBe('imports/import-1/old/missing.mov');
    expect(source.state.drafts[0].uploadStatus).toBe('uploaded');
  });

  it('rejects unsafe namespaces and identity collisions before staging media', () => {
    expect(() => copyPulseDrafts(emptyPulseState(), fixture(), '../escape', () => 'id')).toThrow(
      'Unsafe',
    );
    expect(() =>
      copyPulseDrafts(emptyPulseState(), fixture(), 'imports/safe', () => 'duplicate'),
    ).toThrow('duplicate key');
  });
});
