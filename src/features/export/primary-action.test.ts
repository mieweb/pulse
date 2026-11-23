import { describe, expect, it } from '@jest/globals';

import { type ExportActionsInput, exportActions } from './primary-action';

const base: ExportActionsInput = {
  primaryAction: { kind: 'upload-pool' },
  policy: { allowShare: true, allowSaveToPhotos: true },
  photosAddPurpose: true,
  merging: false,
  destination: null,
};

const pulsevault = { name: 'pulsevault.example.org', spokenName: 'pulsevault dot example dot org' };

describe('exportActions', () => {
  describe('the pool (the Pulse app)', () => {
    it('is an Upload button named for the selected destination', () => {
      const { primary } = exportActions({ ...base, destination: pulsevault });
      expect(primary).toEqual({
        kind: 'upload',
        label: 'pulsevault.example.org',
        accessibilityLabel: 'Upload to pulsevault dot example dot org',
      });
    });

    it('says Upload with nothing selected', () => {
      const { primary } = exportActions(base);
      expect(primary).toEqual({ kind: 'upload', label: 'Upload', accessibilityLabel: 'Upload' });
    });

    it('says the video is being prepared while the merge runs, and still names the destination aloud', () => {
      const { primary } = exportActions({ ...base, merging: true, destination: pulsevault });
      expect(primary.label).toBe('Preparing video…');
      expect(primary.accessibilityLabel).toBe('Upload to pulsevault dot example dot org');
    });
  });

  describe('use-video (inside a host)', () => {
    it('is one button with the host’s label, and no Upload', () => {
      const { primary } = exportActions({
        ...base,
        primaryAction: { kind: 'use-video', label: 'Send to Fix login' },
        destination: pulsevault,
      });
      expect(primary).toEqual({
        kind: 'use-video',
        label: 'Send to Fix login',
        accessibilityLabel: 'Send to Fix login',
      });
    });

    it('falls back to "Use this video" for a blank label', () => {
      const { primary } = exportActions({
        ...base,
        primaryAction: { kind: 'use-video', label: '  ' },
      });
      expect(primary.label).toBe('Use this video');
    });

    it('is not held back by the merge label', () => {
      const { primary } = exportActions({
        ...base,
        merging: true,
        primaryAction: { kind: 'use-video', label: 'Use this video' },
      });
      expect(primary.label).toBe('Use this video');
    });
  });

  describe('Share and Save to Photos', () => {
    it('shows both by default', () => {
      expect(exportActions(base)).toMatchObject({ share: true, saveToPhotos: true });
    });

    it('hides Share when the policy says so', () => {
      const out = exportActions({
        ...base,
        policy: { allowShare: false, allowSaveToPhotos: true },
      });
      expect(out).toMatchObject({ share: false, saveToPhotos: true });
    });

    it('hides Save to Photos when the policy says so', () => {
      const out = exportActions({
        ...base,
        policy: { allowShare: true, allowSaveToPhotos: false },
      });
      expect(out).toMatchObject({ share: true, saveToPhotos: false });
    });

    it('hides Save to Photos when the app lacks the Photos-add purpose string, whatever the policy', () => {
      const out = exportActions({ ...base, photosAddPurpose: false });
      expect(out).toMatchObject({ share: true, saveToPhotos: false });
    });

    it('applies the same policy to a use-video host', () => {
      const out = exportActions({
        ...base,
        primaryAction: { kind: 'use-video', label: '' },
        policy: { allowShare: false, allowSaveToPhotos: false },
      });
      expect(out).toMatchObject({ share: false, saveToPhotos: false });
    });
  });
});
