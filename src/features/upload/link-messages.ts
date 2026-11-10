import { hasNonAsciiHost, shortHost } from '@/utils/format';

import { cleanApp, readReturnUrl } from './deep-link';
import type { ReturnTo } from './types';

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
 * A link for a place is being checked with its server, which the recorder waits for (the server
 * is asked whether it speaks this app's protocol and accepts the link, at most a few seconds).
 * Says so, and with which server.
 */
export function placeCheckingToast(from: { label?: string | null; host: string }): ToastText {
  return { title: from.label ?? 'Opening the link', message: `Checking with ${from.host}…` };
}

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

/**
 * The "Back to …" button for a finished upload's way back, or `null` when there is none to offer.
 * The app's name is the link's own word and isn't signed; where the button leads is the URL's
 * host, so the host is always in the label and always at its end, where a label cut in the middle
 * keeps it (and the host itself is shortened in the middle, never at its end: the registrable
 * domain stays readable). `unusualHost`: the host has non-ASCII letters or their punycode, which
 * can pass for another name — the screen says so beside the button, as the pairing sheet does.
 */
export function backToHost(
  returnTo: ReturnTo | null | undefined,
): { url: string; label: string; unusualHost: boolean } | null {
  const target = readReturnUrl(returnTo?.url);
  if (!target) return null;
  const app = cleanApp(returnTo?.app);
  const host = shortHost(target.host);
  return {
    url: target.url,
    label:
      app && app.toLowerCase() !== target.host ? `Back to ${app} · ${host}` : `Back to ${host}`,
    unusualHost: hasNonAsciiHost(target.host) || /(^|\.)xn--/i.test(target.host),
  };
}
