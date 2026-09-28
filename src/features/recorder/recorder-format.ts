import { Platform } from 'react-native';
import { probeVideo, type VideoProbeResult } from 'react-native-video-trim';

import { getSetting, setSetting } from '@/db/settings';
import { importLog } from './import-log';
import {
  isCanvasFormat,
  NORMALIZE_TARGET_FPS,
  type RecorderFormat,
} from '@/utils/import-normalization';

/**
 * The recorder's copy-compatibility signature on THIS device — what imports are conformed to so
 * a draft mixing recordings and imports merges with zero re-encode (§ imports).
 *
 * It's learned, not hard-coded: coded orientation and the AAC layout differ by platform and
 * device (an iPhone 17 Pro records 5.1 AAC; other phones stereo or mono; CameraX's coded
 * orientation varies), so every recording re-probes and updates it. Until the first recording
 * a best guess is used; a wrong guess only costs a cheap audio remux (or, for geometry, a
 * re-encode) at merge, never correctness.
 */

const RECORDER_FORMAT_KEY = 'recorder.format';

/** Before this device has recorded anything. iOS portrait recordings are coded 1920×1080 under
 * a 90° tag (probeVideo convention, as on real on-device exports); Android starts upright. */
export const DEFAULT_RECORDER_FORMAT: RecorderFormat =
  Platform.OS === 'ios'
    ? { width: 1920, height: 1080, rotation: 90, audioSampleRate: 48000, audioChannels: 2 }
    : { width: 1080, height: 1920, rotation: 0, audioSampleRate: 48000, audioChannels: 2 };

const isPositiveInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0;

/** A stored format, validated (anything unexpected → null, so a corrupt row can't steer imports). */
export function parseRecorderFormat(raw: string | null): RecorderFormat | null {
  if (!raw) return null;
  try {
    const f = JSON.parse(raw) as Partial<RecorderFormat>;
    if (
      !isPositiveInt(f.width) ||
      !isPositiveInt(f.height) ||
      ![0, 90, 180, 270].includes(f.rotation as number) ||
      !isPositiveInt(f.audioSampleRate) ||
      !isPositiveInt(f.audioChannels)
    ) {
      return null;
    }
    const format = f as RecorderFormat;
    return isCanvasFormat(format) ? format : null;
  } catch {
    return null;
  }
}

/**
 * The signature a finished recording shows, or null when it can't serve as the import target
 * (not H.264, not displaying the portrait canvas, not 30 fps, mirrored). A mic-off recording has
 * no audio track: the audio half stays whatever was known before.
 */
export function recorderFormatFromProbe(
  probe: VideoProbeResult,
  previous: RecorderFormat,
): RecorderFormat | null {
  if (!probe.hasVideo || probe.videoCodec !== 'h264' || probe.mirrored) return null;
  const geometry = { width: probe.width, height: probe.height, rotation: probe.rotation };
  if (!isCanvasFormat(geometry)) return null;
  const fps = probe.averageFps > 0 ? probe.averageFps : probe.nominalFps;
  if (Math.round(fps) !== NORMALIZE_TARGET_FPS) return null;
  const audio =
    probe.hasAudio &&
    probe.audioCodec === 'aac' &&
    probe.audioSampleRate > 0 &&
    probe.audioChannels > 0
      ? { audioSampleRate: probe.audioSampleRate, audioChannels: probe.audioChannels }
      : { audioSampleRate: previous.audioSampleRate, audioChannels: previous.audioChannels };
  return { ...geometry, ...audio };
}

/** The current import target: the learned recorder format, else the platform default. */
export async function getRecorderFormat(): Promise<RecorderFormat> {
  return parseRecorderFormat(await getSetting(RECORDER_FORMAT_KEY)) ?? DEFAULT_RECORDER_FORMAT;
}

/** Re-learn the format from a just-finished recording. Best-effort: never throws. */
export async function learnRecorderFormat(uri: string): Promise<void> {
  try {
    const current = await getRecorderFormat();
    const next = recorderFormatFromProbe(await probeVideo(uri), current);
    if (next && JSON.stringify(next) !== JSON.stringify(current)) {
      await setSetting(RECORDER_FORMAT_KEY, JSON.stringify(next));
      importLog.info(`recorder format learned: ${JSON.stringify(next)}`);
    }
  } catch (e) {
    importLog.warn(
      `could not learn the recorder format: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
