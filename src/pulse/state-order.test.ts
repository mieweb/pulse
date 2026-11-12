import { describe, expect, it } from '@jest/globals';

import { emptyPulseState } from './document';
import { preservePulseCollectionOrder } from './state-order';

describe('projection snapshot collection order', () => {
  it('preserves document sequence while taking edited values and dropping deleted identities', () => {
    const previous = emptyPulseState();
    previous.settings = [
      { key: 'z', value: 'last alphabetically, first in YAML' },
      { key: 'removed', value: 'gone' },
      { key: 'a', value: 'last in YAML' },
    ];
    const projected = emptyPulseState();
    projected.settings = [
      { key: 'a', value: 'changed' },
      { key: 'new', value: null },
      { key: 'z', value: 'unchanged' },
    ];
    expect(preservePulseCollectionOrder(projected, previous).settings).toEqual([
      { key: 'z', value: 'unchanged' },
      { key: 'a', value: 'changed' },
      { key: 'new', value: null },
    ]);
    expect(projected.settings[0].key).toBe('a');
    expect(previous.settings[1].key).toBe('removed');
  });

  it('keeps composite transcript identities distinct and explicit clip order edits intact', () => {
    const previous = emptyPulseState();
    const transcript = (model: string) => ({
      segmentId: 'clip',
      model,
      file: 'source.mov',
      status: 'done' as const,
      words: '[]',
      createdAt: 1,
    });
    previous.clipTranscripts = [transcript('z'), transcript('a')];
    const projected = emptyPulseState();
    projected.clipTranscripts = [transcript('a'), transcript('new'), transcript('z')];
    expect(
      preservePulseCollectionOrder(projected, previous).clipTranscripts.map((row) => row.model),
    ).toEqual(['z', 'a', 'new']);
  });
});
