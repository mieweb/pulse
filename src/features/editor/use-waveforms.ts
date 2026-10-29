import { extractAudio } from '@mieweb/pulse-editor';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';

/** One loudness reading per this many ms of source. */
export const PEAK_MS = 20;
const SAMPLE_RATE = 8000;
/** The quietest level drawn: -48 dBFS (room tone sits below it, speech well above). */
const FLOOR_DB = 48;

/**
 * A file's loudness per PEAK_MS, two bytes each: the peak, then the RMS (the average level),
 * 0–255 on a dB scale from -48 dBFS to full scale, which is how loud it sounds.
 */
export type Peaks = Uint8Array;

const level = (amplitude: number) => {
  if (amplitude <= 0) return 0;
  const db = 20 * Math.log10(amplitude / 32768);
  return Math.round(Math.min(1, Math.max(0, (db + FLOOR_DB) / FLOOR_DB)) * 255);
};

// Per file (`file://` URI): its peaks, or null when it has no sound. Shared by every editor.
const memory = new Map<string, Peaks | null>();
const failed = new Set<string>();

const cacheDir = () => new Directory(Paths.cache, 'waveforms');

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Per file, the extraction under way: an effect restarted meanwhile (a reorder) waits for it
// instead of decoding the file a second time.
const running = new Map<string, Promise<Peaks | null>>();

function peaksOf(uri: string): Promise<Peaks | null> {
  let work = running.get(uri);
  if (!work) {
    work = readPeaks(uri).finally(() => running.delete(uri));
    running.set(uri, work);
  }
  return work;
}

async function readPeaks(uri: string): Promise<Peaks | null> {
  const file = new File(cacheDir(), `${hash(uri)}.wave`);
  if (file.exists) {
    const bytes = await file.bytes();
    return bytes.length ? bytes : null;
  }
  const pcm = await extractAudio(uri, { sampleRate: SAMPLE_RATE });
  const samples = new Int16Array(pcm.data);
  const per = Math.max(1, Math.round((pcm.sampleRate * PEAK_MS) / 1000));
  const buckets = Math.ceil(samples.length / per);
  const peaks = new Uint8Array(buckets * 2);
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    let sum = 0;
    const start = b * per;
    const end = Math.min(samples.length, start + per);
    for (let i = start; i < end; i++) {
      const v = samples[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
    }
    peaks[b * 2] = level(peak);
    peaks[b * 2 + 1] = level(Math.sqrt(sum / Math.max(1, end - start)));
  }
  try {
    const dir = cacheDir();
    if (!dir.exists) dir.create({ intermediates: true });
    file.create({ overwrite: true });
    file.write(peaks);
  } catch {
    // Not cached: worked out again next time.
  }
  return peaks.length ? peaks : null;
}

/**
 * The waveform of each file, worked out one file at a time once `enabled` (after the preview's
 * first frame, so it never delays it) and cached on disk. Missing entries are still loading.
 */
export function useWaveforms(uris: readonly string[], enabled: boolean): ReadonlyMap<string, Peaks | null> {
  const [peaks, setPeaks] = useState<ReadonlyMap<string, Peaks | null>>(() => new Map(memory));
  const key = [...new Set(uris)].join('\n');
  useEffect(() => {
    if (!enabled || !key) return;
    let live = true;
    void (async () => {
      for (const uri of key.split('\n')) {
        if (!live) return;
        if (failed.has(uri)) continue;
        if (!memory.has(uri)) {
          try {
            memory.set(uri, await peaksOf(uri));
          } catch {
            // Not drawn (rather than drawn as silence); tried again next session.
            failed.add(uri);
            continue;
          }
        }
        if (live) setPeaks((m) => (m.has(uri) ? m : new Map(m).set(uri, memory.get(uri) ?? null)));
      }
    })();
    return () => {
      live = false;
    };
  }, [key, enabled]);
  return peaks;
}
