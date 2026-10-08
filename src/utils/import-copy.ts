/**
 * Why a clip was rejected on its way in (picker import or `.pulse` unpack), from the reason
 * `conformToContract` threw. The native reasons are stable wording (pulse-editor's
 * Conform.swift / Conform.kt): a file with no readable picture, sound this phone can't decode
 * (rejected rather than imported silent), a damaged file whose frames the decoder dropped
 * (Android). Anything else is a conversion failure worth retrying.
 */
type ImportFailure = 'unreadable' | 'sound' | 'damaged' | 'conversion';

function importFailureKind(why: string): ImportFailure {
  if (/no video stream|no media tracks|probe/i.test(why)) return 'unreadable';
  if (/sound can.t be read/i.test(why)) return 'sound';
  if (/couldn.t decode all of the video/i.test(why)) return 'damaged';
  return 'conversion';
}

/** What the import alert says for a conform rejection. */
export function importFailureCopy(why: string): string {
  switch (importFailureKind(why)) {
    case 'unreadable':
      return 'That file isn’t a video Pulse can read.';
    case 'sound':
      return 'This phone can’t play that video’s sound, so Pulse can’t import it.';
    case 'damaged':
      return 'That video file is damaged: this phone can’t decode all of it.';
    case 'conversion':
      return 'Pulse couldn’t convert it for the timeline. Try again, or pick another video.';
  }
}

/** The same reason as a short note, for a summary line ("2 clips skipped: damaged video"). */
export function importFailureNote(why: string): string {
  switch (importFailureKind(why)) {
    case 'unreadable':
      return 'not a video Pulse can read';
    case 'sound':
      return 'sound this phone can’t play';
    case 'damaged':
      return 'damaged video';
    case 'conversion':
      return 'couldn’t be converted';
  }
}
