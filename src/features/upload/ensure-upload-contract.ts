import { File } from 'expo-file-system';
import { compress, probeVideo } from 'react-native-video-trim';

import { toFileUri, uploadDest } from '@/utils/file-store';

import { hasFaststart } from './faststart';
import { decideUploadContract } from './upload-contract';

/** Reported when a file is compliant in every respect except its `moov` placement. */
const FASTSTART_REASON = 'moov atom at the end of the file';

/**
 * What conditioning did to a file on its way to being uploaded.
 *
 * `path` is always usable — on any failure it falls back to the input, so a broken probe
 * or a failed encode degrades to "upload the original", never to "upload nothing".
 */
export type ContractResult = {
  /**
   * The file to upload: the conditioned copy, or the input when nothing was needed. Always a
   * `file://` URI — callers hand it straight to Expo `File`, and the merged unit's input is a
   * bare path on Android.
   */
  path: string;
  /** True when `path` differs from the input. */
  changed: boolean;
  /** Human-readable contract breaches that triggered the re-encode, for logging/UI. */
  reasons: string[];
  /**
   * Set when the file could NOT be brought into the contract and the original is being
   * uploaded instead. Never silently empty — the whole point of this gate is that a
   * failure is visible. (`importClip` swallows exactly this case today, which is how a
   * 4K master can still enter a draft.)
   */
  failure?: string;
};

/**
 * Bring a file into the upload contract before it is uploaded: probe it, and re-encode
 * only if it breaches (see {@link decideUploadContract}).
 *
 * A compliant file is returned untouched — no copy, no re-encode, no quality generation
 * spent. That is the intended steady state once the recorder emits 1080p/5 Mbps: this
 * gate costs one probe and nothing else. It exists for the case where the recorder's
 * format negotiation loses on some device we have not tested, or an import slips a 4K
 * master through — outcomes we cannot prevent, only catch.
 *
 * Failure policy is deliberately "fail open, loudly": an upload that happens at reduced
 * quality is better than an upload that does not happen, but it must be reported rather
 * than absorbed.
 */
export async function ensureUploadContract(path: string): Promise<ContractResult> {
  // The merged unit arrives as a BARE filesystem path on Android (react-native-video-trim
  // returns one, and `uploadMerged` documents it at the `new File(toFileUri(merged.path))`
  // call one step later). `probeVideo`/`compress` want a file:// URI, so a bare path throws —
  // and the catch below turns that into "upload the original". The gate would therefore fail
  // open on EVERY Android merged upload: present in the code, never actually enforcing.
  // `toFileUri` is a no-op on input that is already a URI, so the iOS/segment paths are
  // unchanged (`absolutize` already yields a URI).
  const uri = toFileUri(path);

  const probe = await probeVideo(uri).catch((e: unknown) => {
    console.warn('[contract] probe failed; uploading the original', e);
    return null;
  });
  if (!probe) {
    return { path: uri, changed: false, reasons: [], failure: 'could not probe the file' };
  }

  const decision = decideUploadContract(probe);
  if (decision.action === 'passthrough') {
    // Compliant on everything a probe can see. `moov` placement is the one part of the
    // contract that is invisible to `probeVideo`, so it is checked separately, by reading
    // the box headers (see faststart.ts).
    //
    // This is not a corner case: the two paths that skip the merge engine — a single-clip
    // draft and every segment upload — hand us a raw AVCaptureMovieFileOutput file, and that
    // API cannot write faststart at all. Those files used to be re-encoded here anyway,
    // because they also breached the codec and bitrate rules, so their `moov` got moved to
    // the front as a side effect. Now that the recorder pins H.264 and the 5 Mbps bitrate
    // actually lands (mieweb/pulse#143), they arrive otherwise compliant and would sail
    // through with the index still at the tail.
    //
    // Only an explicit `false` triggers work. `null` means the scan could not tell, and
    // guessing there would cost a re-encode on every upload forever.
    if (hasFaststart(uri) === false) {
      // Stream-copies the video track and re-encodes only the audio, with `+faststart` on
      // the output — roughly the cost of a file copy, not of a transcode.
      const remuxed = await compress(uri, { copyVideo: true, outputExt: 'mp4' }).catch(
        (e: unknown) => {
          console.warn('[contract] faststart remux failed; uploading the original', e);
          return null;
        },
      );
      if (!remuxed) {
        return {
          path: uri,
          changed: false,
          reasons: [FASTSTART_REASON],
          failure: `could not remux for faststart (${FASTSTART_REASON})`,
        };
      }
      return {
        path: toFileUri(remuxed.outputPath),
        changed: true,
        reasons: [FASTSTART_REASON],
      };
    }
    return { path: uri, changed: false, reasons: [] };
  }

  const result = await compress(uri, { ...decision.options, outputExt: 'mp4' }).catch(
    (e: unknown) => {
      console.warn('[contract] re-encode failed; uploading the original', decision.reasons, e);
      return null;
    },
  );
  if (!result) {
    return {
      path: uri,
      changed: false,
      reasons: decision.reasons,
      failure: `could not re-encode (${decision.reasons.join(', ')})`,
    };
  }

  return { path: toFileUri(result.outputPath), changed: true, reasons: decision.reasons };
}

/**
 * {@link ensureUploadContract} with a stable, reusable output location — the form the SEGMENT
 * upload path needs.
 *
 * Segment uploads resume byte-wise (TUS `HEAD` for the offset, then `PATCH` from there), so a run
 * that resumes must send exactly the bytes it began with. Re-running a re-encode would produce a
 * second, subtly different encode and splice it into a half-finished transfer. Conditioning into a
 * fixed per-clip path means a resumed run finds the file it already made and reuses it — correct
 * first, and a saved re-encode second.
 *
 * The merged path solves the same problem differently: it persists the conditioned path in the
 * draft row, which segments have no column for.
 */
export async function ensureUploadContractCached(
  sourcePath: string,
  draftId: string,
  segmentId: string,
): Promise<ContractResult> {
  // The cache key is the source's BASENAME, not the segment id. `effFile` swaps to
  // `{segmentId}.edited.{rev}.mp4` on a destructive edit while the id stays the same, so an
  // id-keyed cache would return the conditioned copy of the pre-edit clip and upload the wrong
  // bytes. The basename encodes the revision, so edited bytes miss the cache and re-condition.
  const sourceName = sourcePath.split('/').pop() || `${segmentId}.mp4`;
  const dest = uploadDest(draftId, sourceName);
  if (dest.exists && (dest.size ?? 0) > 0) {
    // Already conditioned on an earlier attempt — reuse verbatim.
    return { path: dest.uri, changed: true, reasons: [] };
  }

  const result = await ensureUploadContract(sourcePath);
  if (!result.changed) return result;

  try {
    // compress() writes into the OS-purgeable cache dir; move it somewhere a resume can find it.
    await new File(toFileUri(result.path)).move(dest);
    return { ...result, path: dest.uri };
  } catch (e) {
    // The conditioned bytes exist but could not be parked. Upload them from where they are
    // rather than falling back to the oversized original; a resume may re-encode, which is
    // worse than this but still better than uploading 4K.
    console.warn('[contract] could not park the conditioned clip; using the cache copy', e);
    return result;
  }
}
