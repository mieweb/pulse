import type { CapabilitiesResult } from './capabilities';
import { isTokenExpired } from './capability-token';
import type { UploadDeepLink } from './deep-link';
import type { TokenCheck } from './token-check';

/** The same link reported twice this close together is one opening (see `createLinkGate`). */
const DUPLICATE_URL_MS = 2000;

/**
 * Decides which deliveries of a link are acted on. The system can report one opening twice (the
 * launch URL and a `url` event for it), so the same URL again within two seconds is dropped. A
 * plain link opened again later in the session is ignored too, as it always was (its row may be
 * spent), until another link of either kind comes between. A link for a place is acted on every
 * time: opening it again reopens the place's recorder.
 *
 * `release()`: the link came to nothing (cancelled, couldn't connect, not saved), so the same one
 * opened again — even at once — is a new try.
 */
export function createLinkGate(now: () => number = Date.now) {
  let last: { url: string; at: number } | null = null;
  let handledPlain: string | null = null;
  return {
    admit(url: string, forPlace: boolean): boolean {
      const at = now();
      if (last?.url === url && at - last.at < DUPLICATE_URL_MS) return false;
      last = { url, at };
      // Any other link between two openings of a plain link lets the second through, as before.
      if (forPlace) {
        handledPlain = null;
        return true;
      }
      if (url === handledPlain) return false;
      handledPlain = url;
      return true;
    },
    release(): void {
      last = null;
      handledPlain = null;
    },
  };
}

/**
 * Saves links in the order they were received: of two links for a place that expire in the same
 * second, the newer is the one received last (PROTOCOL.md §5.6). Pairings run at once, each
 * waiting on its own server's answers, so their saves would otherwise land in the order the
 * servers answered.
 *
 * `join()` as a link is handed to pairing. Its `save` runs once every link that joined before it
 * has left; `leave` is called when its own pairing has settled, saved or not.
 */
export function createSaveOrder() {
  let last: Promise<void> = Promise.resolve();
  return {
    join() {
      const before = last;
      let leave: () => void = () => {};
      const left = new Promise<void>((resolve) => (leave = resolve));
      // A link's turn ends once it has left AND every link before it has: one that failed early
      // never lets the links after it save ahead of a link still waiting before it.
      last = Promise.all([before, left]).then(() => {});
      return {
        save: <T>(run: () => Promise<T>): Promise<T> => before.then(run),
        leave,
      };
    },
  };
}

/**
 * What to do with a link for a place before anyone is asked to confirm its server:
 * - `expired`: its token's `exp` has passed on this device's clock. It can't upload anything, so
 *   it is refused with its own message rather than paired and opened as if it worked.
 * - `held`: the place already holds this very link (the same upload, the same token). There is
 *   nothing to pair and nobody to ask: its recorder opens at once, offline included.
 * - `replayed` / `refused`: only for the link the app was launched with, where the system hands an
 *   old one back (`launch`: Android, a relaunch after the process died gets the intent that first
 *   started the app). One Pulse already paired, and no longer holds, has had its upload used (or
 *   was replaced, or removed): it is dropped silently, never paired a second time. One its
 *   server refused is said to be refused again, without asking.
 * - `ok`: go on to confirm its server and pair it.
 *
 * Pulse can't tell the system handing a launch link back from the person tapping the same link
 * again while the app isn't running. So both get the same answer: the recorder for a link the
 * place holds, the message for an expired or refused one, and nothing for one that was used.
 *
 * A plain link is always `ok`: it is handled exactly as before.
 */
export async function screenLink(
  link: UploadDeepLink,
  opts: {
    launch: boolean;
    nowMs: number;
    /** Whether the place's row holds this very link (`placeHoldsLink`). */
    holds(link: UploadDeepLink): Promise<boolean>;
    /** What a link Pulse dealt with before came to (`handledLinkOutcome`). */
    outcome(artifactId: string): Promise<'paired' | 'refused' | null>;
  },
): Promise<'ok' | 'expired' | 'held' | 'replayed' | 'refused'> {
  if (!link.place) return 'ok';
  if (isTokenExpired(link.token, opts.nowMs)) return 'expired';
  if (await opts.holds(link).catch(() => false)) return 'held';
  if (!opts.launch) return 'ok';
  const outcome = await opts.outcome(link.artifactId).catch(() => null);
  return outcome === 'paired' ? 'replayed' : (outcome ?? 'ok');
}

export type PairFailure =
  /** The server can't be reached, or doesn't speak this app's protocol. */
  | 'unreachable'
  | 'version-too-old'
  | 'version-too-new'
  /** The server didn't accept the link's token: a forged or changed link, or one it has expired. */
  | 'refused'
  /** The destination couldn't be stored on this device. */
  | 'not-saved';

export type PairResult = { ok: true } | { ok: false; reason: PairFailure };

export type PairDeps = {
  checkCapabilities(server: string): Promise<CapabilitiesResult>;
  /** What the server makes of the link's token (`checkToken`); rejects when it gives no answer. */
  checkToken(link: UploadDeepLink & { token: string }): Promise<TokenCheck>;
  /**
   * Store the link's destination in the pool. `accepted`: the server took the link's token, so
   * the link may take over from the one its place holds (`takesOver`).
   */
  save(link: UploadDeepLink, accepted: boolean): Promise<unknown>;
  /** Remember what a link for a place came to (`rememberHandledLink`). */
  remember(artifactId: string, outcome: 'paired' | 'refused'): Promise<void>;
};

/**
 * Pair a link whose server the person has confirmed: check the server speaks this app's protocol,
 * and store the destination. For a link that names a place the server is also asked whether it
 * accepts the link's token (PROTOCOL.md §5.6), since the place is read from a token Pulse can't
 * verify:
 * - `accepted`: the link may take over from the one the place holds, if it is the newer;
 * - `refused`: the link is dropped, and the place keeps what it has;
 * - `unknown` (no status route, a server error, no answer): never treated as accepted. The link
 *   becomes the link of a place that holds none; a place that holds one keeps it, and is opened
 *   as it is.
 *
 * The two requests go out together, both to the server the person confirmed, so the recorder
 * waits for the slower one and not for their sum.
 */
export async function pairLink(link: UploadDeepLink, deps: PairDeps): Promise<PairResult> {
  const { place, token } = link;
  const [capabilities, check] = await Promise.all([
    deps.checkCapabilities(link.server),
    place && token
      ? deps.checkToken({ ...link, token }).catch((): TokenCheck => 'unknown')
      : ('unknown' as const),
  ]);
  if (!capabilities.ok) return { ok: false, reason: capabilities.reason };
  if (check === 'refused') {
    await deps.remember(link.artifactId, 'refused').catch(() => {});
    return { ok: false, reason: 'refused' };
  }
  try {
    await deps.save(link, check === 'accepted');
  } catch {
    return { ok: false, reason: 'not-saved' };
  }
  if (place) await deps.remember(link.artifactId, 'paired').catch(() => {});
  return { ok: true };
}
