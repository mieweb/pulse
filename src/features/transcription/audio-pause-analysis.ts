import { extractAudio } from '@mieweb/pulse-editor';

import {
  candidatesInWindow,
  findQuietPauseCandidates,
  type CleanupCandidate,
  type QuietPauseOptions,
} from './speech-cleanup';

const checkCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error('Pause analysis cancelled.');
};

/**
 * One analysis job caches only proposal arrays, never decoded PCM. Split beats sharing a file
 * reuse the audio scan. Create a new analyzer when beginning another review so stale source
 * files/settings are never kept in a process-wide cache.
 */
export function createQuietPauseAnalyzer(signal?: AbortSignal) {
  const jobs = new Map<string, Promise<CleanupCandidate[]>>();
  return async (uri: string, options: QuietPauseOptions = {}): Promise<CleanupCandidate[]> => {
    checkCancelled(signal);
    const { window, ...settings } = options;
    const key = JSON.stringify([uri, settings]);
    let job = jobs.get(key);
    if (!job) {
      job = (async () => {
        const audio = await extractAudio(uri);
        checkCancelled(signal);
        return findQuietPauseCandidates(audio.data, audio.sampleRate, settings);
      })();
      jobs.set(key, job);
      // A transient decoding failure can be retried during the same analysis job.
      void job.catch(() => jobs.delete(key));
    }
    const candidates = await job;
    checkCancelled(signal);
    return candidatesInWindow(candidates, window);
  };
}

/** Analyze a single source without retaining decoded audio beyond this call. */
export function analyzeQuietPauses(
  uri: string,
  options: QuietPauseOptions = {},
  signal?: AbortSignal,
): Promise<CleanupCandidate[]> {
  return createQuietPauseAnalyzer(signal)(uri, options);
}
