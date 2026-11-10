import type { CapabilitiesResult } from './capabilities';
import { isTokenExpired } from './capability-token';
import type { UploadDeepLink } from './deep-link';
import type { TokenCheck } from './token-check';

/** The same link reported twice this close together is one opening (see `createLinkGate`). */
const DUPLICATE_URL_MS = 2000;

/**
 * Decides which deliveries of a link are acted on. The system can report one opening twice (the
 * launch URL and a `url` event for it), so the same URL again within two seconds is dropped. A
 * plain link opened again later in the session is ignored too, as it always was: its row may be
 * spent. A link for a place is acted on every time: opening it again reopens the place's recorder.
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
      if (forPlace) return true;
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
 * Whether a link is worth asking about at all, before anyone is asked to confirm its server:
 * - `replayed`: the link the app was launched with (`launch`) is one already dealt with — the
 *   system handing an old launch link back (Android, a relaunch from Recents). Dropped silently.
 * - `expired`: its token's `exp` has passed on this device's clock; it can't upload anything, so
 *   it is refused with its own message rather than paired and opened as if it worked.
 * A plain link is always `ok`: it is handled exactly as before.
 */
export async function screenLink(
  link: UploadDeepLink,
  opts: { launch: boolean; nowMs: number; wasHandled(artifactId: string): Promise<boolean> },
): Promise<'ok' | 'replayed' | 'expired'> {
  if (!link.place) return 'ok';
  if (opts.launch && (await opts.wasHandled(link.artifactId).catch(() => false))) {
    return 'replayed';
  }
  return isTokenExpired(link.token, opts.nowMs) ? 'expired' : 'ok';
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
  /** Whether the server accepts the link's token (`checkToken`); rejects when it can't be asked. */
  checkToken(link: UploadDeepLink & { token: string }): Promise<TokenCheck>;
  /** Store the link's destination in the pool. */
  save(link: UploadDeepLink): Promise<unknown>;
  /** Remember a link for a place as dealt with (`rememberHandledLink`). */
  remember(artifactId: string): Promise<void>;
};

/**
 * Pair a link whose server the person has confirmed: check the server speaks this app's protocol,
 * and store the destination. A link for a place does one thing more first: the place it names is
 * read from a token Pulse can't verify, so the server is asked whether it accepts that token, and
 * only then does the link take over what the place has (PROTOCOL.md §5.6) — a forged link is
 * refused here, and the place keeps its real one. A server that can't answer that question
 * (`unknown`) doesn't block the pairing: its first upload settles it.
 */
export async function pairLink(link: UploadDeepLink, deps: PairDeps): Promise<PairResult> {
  const capabilities = await deps.checkCapabilities(link.server);
  if (!capabilities.ok) return { ok: false, reason: capabilities.reason };
  const { place, token } = link;
  if (place && token) {
    let check: TokenCheck;
    try {
      check = await deps.checkToken({ ...link, token });
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
    if (check === 'refused') {
      // Dealt with for good: the same link handed back at a later launch stays quiet.
      await deps.remember(link.artifactId).catch(() => {});
      return { ok: false, reason: 'refused' };
    }
  }
  try {
    await deps.save(link);
  } catch {
    return { ok: false, reason: 'not-saved' };
  }
  if (place) await deps.remember(link.artifactId).catch(() => {});
  return { ok: true };
}
