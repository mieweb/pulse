import type { MergeOptions } from '@mieweb/pulse-editor';

import type { VoiceoverTake } from '@/db/schema';
import { absolutize } from '@/utils/file-store';

/** Saved draft audio, independent of the ordered video clips. */
export type VoiceoverMix = {
  takes: readonly VoiceoverTake[];
  sourceMuted: boolean;
  voiceoverMuted: boolean;
};

export const EMPTY_VOICEOVER: VoiceoverMix = {
  takes: [],
  sourceMuted: false,
  voiceoverMuted: false,
};

/** One mapping for native preview and export: trim the source, place it on the draft clock. */
export function toVoiceoverMix(
  mix: VoiceoverMix,
): Pick<MergeOptions, 'voiceover' | 'sourceMuted' | 'voiceoverMuted'> {
  return {
    sourceMuted: mix.sourceMuted,
    voiceoverMuted: mix.voiceoverMuted,
    voiceover: mix.takes.map((take) => ({
      uri: absolutize(take.filename),
      timelineStartMs: take.startMs,
      sourceStartMs: take.trimStartMs,
      sourceEndMs: take.trimEndMs,
    })),
  };
}
