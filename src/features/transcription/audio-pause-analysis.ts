import { extractAudio } from '@mieweb/pulse-editor';

import {
  DEFAULT_QUIET_PAUSE_OPTIONS,
  quietPauseCandidates,
  scanQuietAudio,
  type CleanupCandidate,
  type QuietAudioScan,
  type QuietPauseOptions,
} from './speech-cleanup';

const checkCancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error('Pause analysis cancelled.');
};

/**
 * One analysis job caches raw quiet spans, never decoded PCM. Split beats sharing a file reuse
 * the energy scan, but qualify and pad each played window separately. Start a new analyzer for
 * another review so changed source files are never kept in a process-wide cache.
 */
export function createQuietPauseAnalyzer(signal?: AbortSignal) {
  const jobs = new Map<string, Promise<QuietAudioScan>>();
  return async (uri: string, options: QuietPauseOptions = {}): Promise<CleanupCandidate[]> => {
    checkCancelled(signal);
    const {
      thresholdDb = DEFAULT_QUIET_PAUSE_OPTIONS.thresholdDb,
      peakDb = DEFAULT_QUIET_PAUSE_OPTIONS.peakDb,
    } = options;
    const key = JSON.stringify([uri, thresholdDb, peakDb]);
    let job = jobs.get(key);
    if (!job) {
      job = (async () => {
        const audio = await extractAudio(uri);
        checkCancelled(signal);
        return scanQuietAudio(audio.data, audio.sampleRate, { thresholdDb, peakDb });
      })();
      jobs.set(key, job);
      // A transient decoding failure can be retried during the same analysis job.
      void job.catch(() => {
        if (jobs.get(key) === job) jobs.delete(key);
      });
    }
    const scan = await job;
    checkCancelled(signal);
    return quietPauseCandidates(scan, options);
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
