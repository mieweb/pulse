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

/**
 * Why an image couldn't be made into a clip, from pulse-editor `imageClip`'s stable wording: one
 * this phone can't decode (HEIC on an Android phone without a HEIF decoder), a file that's gone,
 * a full disk.
 */
export function imageFailureCopy(why: string): string {
  if (importFailureKind(why) === 'space') {
    return 'This phone is out of space. Free some up, then try again.';
  }
  if (/can.t be read on this device/i.test(why)) return 'This image can’t be read on this device.';
  if (/file is missing/i.test(why)) return 'The image’s file is missing.';
  return 'Pulse couldn’t make a clip from it. Try again, or pick another image.';
}

/** "Adding 2 of 5", for the busy "+" (screen readers; one image reads "Adding the image"). */
export function imageStepText(index: number, total: number): string {
  return total > 1 ? `Adding ${index + 1} of ${total}` : 'Adding the image';
}

/**
 * What to say once a batch of images is done: nothing when every image was added; else which
 * weren't and why (the first reason: a batch fails for one reason far more often than for many).
 */
export function imageBatchNotice({
  total,
  skipped,
}: {
  total: number;
  skipped: readonly { why: string }[];
}): { kind: 'error' | 'warning'; title: string; message: string } | null {
  if (skipped.length === 0) return null;
  const message = imageFailureCopy(skipped[0].why);
  if (skipped.length >= total) {
    return {
      kind: 'error',
      title: total === 1 ? 'Couldn’t add the image' : 'Couldn’t add the images',
      message,
    };
  }
  return {
    kind: 'warning',
    title:
      skipped.length === 1
        ? `1 of ${total} images wasn’t added`
        : `${skipped.length} of ${total} images weren’t added`,
    message,
  };
}
