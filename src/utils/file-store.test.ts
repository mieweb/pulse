import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { emptyPulseState, type PulseDocument } from '@/pulse/document';
import { getPulseDocument } from '@/pulse/runtime';
import { deleteDraftDir, deleteSegmentFile } from './file-store';

const mockDeleted: string[] = [];
jest.mock('expo-file-system', () => {
  class Entry {
    uri: string;
    exists = true;
    constructor(...parts: string[]) {
      this.uri = parts.join('/');
    }
    delete() {
      mockDeleted.push(this.uri);
    }
  }
  return { File: Entry, Directory: Entry, Paths: { document: 'file:///documents' } };
});
jest.mock('@/pulse/runtime', () => ({ getPulseDocument: jest.fn() }));

function document(): PulseDocument {
  const state = emptyPulseState();
  state.segments.push({
    id: 'shared',
    draftId: 'survivor',
    order: 0,
    label: null,
    originalFilename: 'drafts/deleted/shared.mov',
    durationMs: 100,
    editedFilename: 'drafts/deleted/shared.edited.mp4',
    editedDurationMs: 90,
    editState: null,
    thumbnail: 'drafts/deleted/shared.thumb.jpg',
    captionEdit: null,
  });
  return { format: 'pulse-document', version: 2, scope: 'library', revision: 1, state, assets: [] };
}

beforeEach(() => {
  mockDeleted.length = 0;
  jest.mocked(getPulseDocument).mockReturnValue(document());
});

describe('working media cleanup follows canonical references', () => {
  it('retains shared original, baked edit, thumbnail and their enclosing deleted-owner directory', () => {
    deleteSegmentFile('drafts/deleted/shared.mov');
    deleteSegmentFile('drafts/deleted/shared.edited.mp4');
    deleteSegmentFile('drafts/deleted/shared.thumb.jpg');
    deleteDraftDir('deleted');
    expect(mockDeleted).toEqual([]);
  });

  it('deletes unreferenced working files and directories after canonical removal', () => {
    const current = document();
    current.state.segments = [];
    jest.mocked(getPulseDocument).mockReturnValue(current);
    deleteSegmentFile('drafts/deleted/shared.mov');
    deleteDraftDir('deleted');
    expect(mockDeleted).toEqual([
      'file:///documents/drafts/deleted/shared.mov',
      'file:///documents/drafts/deleted/shared.upload.mp4',
      'file:///documents/drafts/deleted',
    ]);
  });

  it('defers cleanup when canonical recovery is unavailable', () => {
    jest.mocked(getPulseDocument).mockImplementation(() => {
      throw new Error('recovery needed');
    });
    deleteSegmentFile('orphan.mov');
    deleteDraftDir('orphan');
    expect(mockDeleted).toEqual([]);
  });
});
