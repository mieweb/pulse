import { describe, expect, it, jest } from '@jest/globals';

jest.mock('@/utils/file-store', () => ({ absolutize: (path: string) => `file:///docs/${path}` }));

/* eslint-disable import/first -- register native filesystem mock first */
import { EMPTY_VOICEOVER, toVoiceoverMix } from './voiceover';
import type { VoiceoverTake } from '@/db/schema';
/* eslint-enable import/first */

describe('voiceover native mix', () => {
  it('places the trimmed audio on the independent draft timeline for both preview and export', () => {
    const take = {
      filename: 'drafts/d1/voiceover/a.caf',
      startMs: 12_000,
      durationMs: 60_000,
      trimStartMs: 250,
      trimEndMs: 59_750,
    } as VoiceoverTake;
    expect(toVoiceoverMix({ takes: [take], sourceMuted: false, voiceoverMuted: true })).toEqual({
      voiceover: [
        {
          uri: 'file:///docs/drafts/d1/voiceover/a.caf',
          timelineStartMs: 12_000,
          sourceStartMs: 250,
          sourceEndMs: 59_750,
        },
      ],
      sourceMuted: false,
      voiceoverMuted: true,
    });
  });

  it('does not mute source audio by default', () => {
    expect(toVoiceoverMix(EMPTY_VOICEOVER)).toEqual({
      voiceover: [],
      sourceMuted: false,
      voiceoverMuted: false,
    });
  });
});
