import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import { conform, probe } from '@mieweb/pulse-editor';

import { checkConform } from './conform-verify';
import { decideImport, type RecorderFormat } from './import-normalization';

/** A clip conformed by `conformToContract`. */
export type ConformOutcome = {
  /** The conformed file (`file://` URI), in the OS-purgeable cache dir — callers move it into place. */
  path: string;
  /** Media stack that produced it (`AVFoundation` | `Media3`), for the debug log. */
  engine: string;
  /** Whether it also carries the recorder's signature (joins recordings with no re-encode). */
  mergeMatch: boolean;
  /** One-line facts for the debug log: why it was converted, merge misses. */
  notes: string[];
};

function describe(e: unknown): string {
  return e instanceof Error ? e.message.split('\n')[0] : String(e);
}

function remove(uri: string) {
  try {
    new File(uri).delete();
  } catch {}
}

/**
 * Enforce the portrait reels contract on a clip FILE (probe + the import-normalization policy,
 * re-encoding when off-contract). Resolves to the conformed output, or `null` when the clip
 * already conforms (and, with a `target`, already matches the recorder). Throws when the clip
 * has no video stream or can't be probed/conformed: callers fail closed.
 *
 * With a `target` (imports), off-signature clips are written in the recorder's exact format so
 * a draft mixing recordings and imports merges without re-encoding. Without one (the `.pulse`
 * unpack gate), only the display-level contract is enforced.
 *
 * The conversion is pulse-editor's `conform` on the platform media stack (AVFoundation /
 * Media3: hardware decode and encode, real HDR tone mapping). Its output is verified here
 * (contract, audio kept, full length) and rejected otherwise; there is no second engine. A video
 * whose sound the phone can't decode is rejected too, never imported silent.
 *
 * `signal` cancels it: the conversion is stopped natively and the call rejects with "Import
 * cancelled" right away.
 *
 * Container layout (faststart) is deliberately NOT part of this gate: raw recorder files are
 * moov-at-end by AVFoundation constraint (see the codec-pin note in use-recorder.ts) and the
 * vault's web-ready backstop owns progressive-playback normalization for raw segments; every
 * locally re-encoded artifact (this gate's conforms, merges, imports) does carry faststart.
 */
export async function conformToContract(
  uri: string,
  target?: RecorderFormat,
  signal?: AbortSignal,
): Promise<ConformOutcome | null> {
  if (signal?.aborted) throw new Error('Import cancelled');
  const work = run(uri, target, signal);
  if (!signal) return work;

  // Reject the moment the signal aborts — never wait on the native side to confirm: a conversion
  // interrupted by the app going to the background can stay stuck until iOS resumes it (if ever).
  // The abort still stops it natively; a result that lands anyway is thrown away.
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Import cancelled'));
    signal.addEventListener('abort', onAbort);
  });
  void work.then(
    (outcome) => {
      if (signal.aborted && outcome) remove(outcome.path);
    },
    () => {},
  );
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function run(
  uri: string,
  target: RecorderFormat | undefined,
  signal: AbortSignal | undefined,
): Promise<ConformOutcome | null> {
  const source = await probe(uri);
  if (signal?.aborted) throw new Error('Import cancelled');
  // decideImport passes no-video files through (audio-only is fine for a library), but a
  // SEGMENT without a video stream can never satisfy the portrait contract — fail closed.
  if (!source.video) throw new Error('Clip has no video stream.');
  const decision = decideImport(source, target);
  if (decision.action === 'passthrough') return null;

  let result;
  try {
    result = await conform(uri, decision.options, { signal });
  } catch (e) {
    if (signal?.aborted) throw new Error('Import cancelled');
    throw new Error(`Could not convert this video (${describe(e)})`);
  }
  if (signal?.aborted) {
    remove(result.uri);
    throw new Error('Import cancelled');
  }

  const output = await probe(result.uri).catch(() => null);
  const check = output
    ? checkConform(source, output, target)
    : { fatal: ['output unreadable'], short: null, mergeMatch: false, mergeMisses: [] };
  if (check.fatal.length > 0 || check.short) {
    remove(result.uri);
    const why = check.fatal.length ? check.fatal.join('; ') : `short output (${check.short})`;
    throw new Error(`Could not convert this video (${why})`);
  }

  const notes = [`conform: ${decision.reasons.join('; ')}`];
  if (target && !check.mergeMatch) notes.push(`merge signature missed: ${check.mergeMisses.join('; ')}`);
  return {
    path: result.uri,
    engine: Platform.OS === 'ios' ? 'AVFoundation' : 'Media3',
    mergeMatch: check.mergeMatch,
    notes,
  };
}
