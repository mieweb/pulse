/**
 * The one way Pulse says a link has to be opened again (it expired, or its destination is gone):
 * by the place's label when it has one, else by the server's host.
 */
export function openLinkAgain(from: { label?: string | null; host: string }): string {
  return from.label
    ? `Open the link for ${from.label} again to upload.`
    : `Open the link from ${from.host} again to upload.`;
}

/** The same, to follow a dash in a one-line message ("Upload link expired — open the link…"). */
export function openLinkAgainClause(from: { label?: string | null; host: string }): string {
  const sentence = openLinkAgain(from);
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

type ToastText = { title: string; message: string };

/**
 * A link for a place was paired and its recorder is up. The place's label is the link's own word
 * for it and isn't signed, and no sheet asked about a trusted server: so the toast always says
 * which server the video goes to.
 */
export function placeOpenedToast(opts: {
  label: string | null;
  host: string;
  draftOpen: boolean;
  trustNotSaved?: boolean;
}): ToastText {
  return {
    title: opts.label ?? `Connected to ${opts.host}`,
    message:
      (opts.draftOpen
        ? `Your draft is open. It uploads to ${opts.host}.`
        : `Record, then upload to ${opts.host}.`) +
      (opts.trustNotSaved ? ' Pulse couldn’t save “Don’t ask again”.' : ''),
  };
}

/** A link for a place whose token had already expired when it was opened. */
export function linkExpiredToast(from: { label?: string | null; host: string }): ToastText {
  return { title: 'This link has expired', message: openLinkAgain(from) };
}

/** A link for a place whose server didn't accept its token. */
export function linkRefusedToast(from: { label?: string | null; host: string }): ToastText {
  return {
    title: 'Couldn’t use this link',
    message: `${from.host} didn’t accept it. ${openLinkAgain(from)}`,
  };
}

/** The link was paired, but its recorder couldn't be opened. */
export function recorderFailedToast(host: string): ToastText {
  return {
    title: 'Couldn’t open the recorder',
    message: `The link is saved: record from Home, then upload to ${host}.`,
  };
}
