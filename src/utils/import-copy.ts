/**
 * Why a clip was rejected on its way in (picker import, screen recording or `.pulse` unpack), from
 * the reason `conformToContract` (or the copy into the draft) threw. The native reasons are stable
 * wording (pulse-editor's Conform.swift / Conform.kt): a file with no readable picture, sound this
 * phone can't decode (rejected rather than imported silent), a damaged file whose frames the
 * decoder dropped (Android: "couldn't decode all of the video"; iOS: "Only … of the … video could
 * be decoded"), a full disk (ENOSPC, Cocoa's out-of-space error, AVFoundation's disk full).
 * Anything else is a conversion failure worth retrying.
 */
type ImportFailure = 'space' | 'unreadable' | 'sound' | 'damaged' | 'conversion';

function importFailureKind(why: string): ImportFailure {
  if (/ENOSPC|no space left|out of space|enough space|disk (is )?full|-11807/i.test(why)) {
    return 'space';
  }
  if (/no video stream|no media tracks|probe/i.test(why)) return 'unreadable';
  if (/sound can.t be read/i.test(why)) return 'sound';
  if (/couldn.t decode all of the video|video could be decoded/i.test(why)) return 'damaged';
  return 'conversion';
}

/** Whether a failure was the phone running out of space. */
export function isOutOfSpace(why: string): boolean {
  return importFailureKind(why) === 'space';
}

/**
 * What the import error says for a rejection. `screen`: a screen recording, whose alert offers
 * Try again (it isn't picked, so there's no other video to pick).
 */
export function importFailureCopy(why: string, from: 'picker' | 'screen' = 'picker'): string {
  switch (importFailureKind(why)) {
    case 'space':
      return from === 'screen'
        ? 'This phone is out of space. Free some up, then tap Try again.'
        : 'This phone is out of space. Free some up, then try again.';
    case 'unreadable':
      return 'That file isn’t a video Pulse can read.';
    case 'sound':
      return 'This phone can’t play that video’s sound, so Pulse can’t import it.';
    case 'damaged':
      return 'That video file is damaged: this phone can’t decode all of it.';
    case 'conversion':
      return from === 'screen'
        ? 'Pulse couldn’t convert it for the timeline.'
        : 'Pulse couldn’t convert it for the timeline. Try again, or pick another video.';
  }
}

/** The same reason as a short note, for a summary line ("2 clips skipped: damaged video"). */
export function importFailureNote(why: string): string {
  switch (importFailureKind(why)) {
    case 'space':
      return 'out of space';
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
