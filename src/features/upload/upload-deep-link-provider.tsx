import { getInitialURL, useLinkingURL } from 'expo-linking';
import { router, useRootNavigationState } from 'expo-router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';

import { addDestination } from '@/db/destinations';
import { useToast } from '@/features/toast/toast-provider';
import { hostOf, shortHost } from '@/utils/format';

import { CAPABILITIES_REJECTION_MESSAGE, checkCapabilities } from './capabilities';
import { checkDeferredPairing } from './deferred-pairing';
import { pairingLinkParams, parseUploadDeepLink, type UploadDeepLink } from './deep-link';
import { LINK_HOST } from './link-host';
import { isTrustedServer, trustServer } from './trusted-servers';
import { uploads } from './upload-manager';
import { reloadDestinationTokens } from './use-destinations';

const REJECTION_MESSAGE: Record<'unsupported-version' | 'invalid-link', string> = {
  'unsupported-version':
    'This upload link needs a newer version of Pulse. Update the app and try again.',
  'invalid-link': 'This upload link looks damaged. Ask for a new one and try again.',
};

/** What the pairing sheet (`/pair`) is asking. */
export type PairingRequest =
  /** A link was opened: confirm its server before Pulse contacts it (TOFU, PROTOCOL.md §3). */
  | { kind: 'confirm'; link: UploadDeepLink; host: string }
  /** iOS first launch after a store install: paste the link the `/pulse/open` page copied. */
  | { kind: 'paste' };

type PairingSheet = {
  request: PairingRequest | null;
  /** Confirm: contact the server and add it to the pool; `trust` skips the sheet next time. */
  connect(trust: boolean): void;
  /** Paste: pair from the pasted text straight away; the person chose this link on the page. */
  pairPasted(text: string): void;
  /** Cancel: close the sheet; nothing was persisted and no request made. */
  cancel(): void;
  /** The sheet went away without an answer (swiped down): same as cancel, minus the close. */
  closed(shown: PairingRequest): void;
};

const PairingSheetContext = createContext<PairingSheet>({
  request: null,
  connect: () => {},
  pairPasted: () => {},
  cancel: () => {},
  closed: () => {},
});

/** The pairing sheet's request and actions, for the `/pair` route. */
export function usePairingSheet(): PairingSheet {
  return useContext(PairingSheetContext);
}

/**
 * Mounts the single global pairing-link listener (`pulsecam://` and the https link form, #252)
 * for the app's lifetime, matching `TranscriptionProvider`'s pattern — a provider rather than a
 * bare hook, so it's guaranteed to subscribe exactly once regardless of where it's rendered,
 * avoiding duplicate-listener bugs.
 *
 * A recognized link opens the pairing sheet (`/pair`), which asks the user to confirm the
 * server's origin (TOFU) before anything is fetched from it. Confirming adds the destination to
 * the device-wide pool (db/destinations.ts) and toasts — it does NOT pick a draft. Any draft (a
 * fresh recording or an existing one) can select it later from its export screen, and several
 * servers can be paired at once. Each destination is single-use (one server-minted artifactId)
 * and drops out of the pool once a draft claims it or the user deletes it.
 *
 * On the first launch after a store install it also picks up the link the `/pulse/open` page
 * handed over (deferred-pairing.ts): Android's install referrer goes through the same
 * confirmation; iOS shows the sheet's paste variant.
 *
 * It also starts the upload manager for the app's lifetime: the launch check,
 * and the toast an upload failure shows in the foreground.
 */
export function UploadDeepLinkProvider({ children }: { children: React.ReactNode }) {
  const url = useLinkingURL();
  const handledUrl = useRef<string | null>(null);
  const { showToast } = useToast();
  const [request, setRequest] = useState<PairingRequest | null>(null);
  const requestRef = useRef(request);
  useEffect(() => {
    requestRef.current = request;
  }, [request]);
  const sheetOpen = useRef(false);
  // Bumped when the sheet goes away while a newer request waits, so the effect below shows it.
  const [sheetGone, bumpSheetGone] = useReducer((n: number) => n + 1, 0);
  const navigationReady = !!useRootNavigationState()?.key;

  // At launch, fail the uploads a killed app never finished (see `prepareLaunch`); on every
  // foreground, poke the drain so an upload whose JS was suspended in the background carries on.
  useEffect(() => {
    uploads.registerToast(showToast);
    void uploads.prepareLaunch();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void uploads.ensureRunning();
    });
    return () => sub.remove();
  }, [showToast]);

  // Show the sheet for a request once the navigator can take a push (a cold-start link arrives
  // before it's mounted). A second link while it's open replaces what the open sheet shows; one
  // that arrives as the sheet is swiped away opens it again (`closed`).
  useEffect(() => {
    if (!request || sheetOpen.current || !navigationReady) return;
    sheetOpen.current = true;
    router.push('/pair');
  }, [request, navigationReady, sheetGone]);

  const closeSheet = useCallback(() => {
    if (sheetOpen.current && router.canGoBack()) router.back();
    sheetOpen.current = false;
    setRequest(null);
  }, []);

  const addToPool = useCallback(
    // `trusted`: paired without the sheet. `trustNotSaved`: "Don't ask again" was ticked but
    // didn't save.
    (link: UploadDeepLink, trusted = false, trustNotSaved = false) => {
      const host = hostOf(link.server);
      checkCapabilities(link.server)
        .then((capResult) => {
          if (!capResult.ok) {
            showToast({
              kind: 'error',
              title: 'Couldn’t connect',
              message: CAPABILITIES_REJECTION_MESSAGE[capResult.reason],
            });
            return;
          }
          // Added to the device-wide pool (not a single slot) — any draft can pick it at
          // upload time, and several servers can be paired at once.
          return addDestination({
            server: link.server,
            token: link.token,
            artifactId: link.artifactId,
          }).then(() => {
            // The same link again keeps its row id: open screens reload its fresh token.
            reloadDestinationTokens();
            // A trusted server pairs without the sheet, so the toast says why nothing asked.
            showToast({
              kind: trusted ? 'info' : 'success',
              title: `Connected to ${shortHost(host)}`,
              message: trusted
                ? 'You chose not to be asked for this server. Pick it when you upload.'
                : trustNotSaved
                  ? 'Pick it when you upload. Pulse couldn’t save “Don’t ask again”, so its next link asks first.'
                  : 'Pick it when you upload.',
            });
          });
        })
        .catch(() => {
          // Let the same link be retried — nothing was persisted, so silently swallowing this
          // would leave the user stuck with no path forward but to restart the app.
          handledUrl.current = null;
          showToast({
            kind: 'error',
            title: 'Couldn’t connect',
            message: CAPABILITIES_REJECTION_MESSAGE.unreachable,
          });
        });
    },
    [showToast],
  );

  // A link in either form (`pulsecam://` or the https link): validate it, then ask the sheet to
  // confirm its server, unless the person ticked "Don't ask again" for it. Linking links and
  // Android's install referrer share it.
  const confirmLink = useCallback(
    (pairingUrl: string) => {
      const result = parseUploadDeepLink(pairingUrl, LINK_HOST);
      // Failures that leave nothing to decide are toasts; only the pairing itself asks (the sheet).
      if (!result.ok) {
        showToast({
          kind: 'error',
          title: 'Couldn’t open this link',
          message: REJECTION_MESSAGE[result.reason],
        });
        return;
      }
      const { link } = result;
      void isTrustedServer(link.server)
        .catch(() => false)
        .then((trusted) => {
          if (trusted) addToPool(link, true);
          else setRequest({ kind: 'confirm', link, host: hostOf(link.server) });
        });
    },
    [addToPool, showToast],
  );

  useEffect(() => {
    const params = url ? pairingLinkParams(url, LINK_HOST) : null;
    if (!url || url === handledUrl.current || params === null) return;
    handledUrl.current = url;
    // Bare `pulsecam://` (Android's upload notification opens it) only brings the app forward.
    if (params === '') return;

    // `+native-intent` keeps the router on the current screen for both link forms, so the sheet
    // opens over whatever is up (recorder, export, onboarding…) and closing it returns there.
    confirmLink(url);
  }, [url, confirmLink]);

  // First launch after a store install: the pairing link the `/pulse/open` page handed over.
  // Skipped when this launch came from a pairing link, which already carries the pairing. Asks
  // for the launch URL itself: `useLinkingURL` resolves it asynchronously, so its first render
  // can be null on a cold start from a link.
  useEffect(() => {
    void getInitialURL()
      .catch(() => null)
      .then((initial) => checkDeferredPairing(!!initial && !!pairingLinkParams(initial, LINK_HOST)))
      .then((found) => {
        if (found?.kind === 'link') confirmLink(found.url);
        if (found?.kind === 'pasteboard') setRequest({ kind: 'paste' });
      })
      .catch(() => {});
  }, [confirmLink]);

  const sheet = useMemo<PairingSheet>(
    () => ({
      request,
      connect: (trust) => {
        const link = request?.kind === 'confirm' ? request.link : null;
        closeSheet();
        if (!link) return;
        if (!trust) return addToPool(link);
        // Pairs either way; a failed save is said in the "Connected" toast, which would cover a
        // toast of its own.
        void trustServer(link.server).then(
          () => addToPool(link),
          () => addToPool(link, false, true),
        );
      },
      pairPasted: (text) => {
        closeSheet();
        const result = parseUploadDeepLink(text.trim(), LINK_HOST);
        if (result.ok) addToPool(result.link);
        else
          showToast({
            kind: 'error',
            title: 'No Pulse link found',
            message: 'What you copied isn’t a Pulse link. Scan the code or open the link again.',
          });
      },
      cancel: () => {
        // Let the same link be scanned/opened again if the user changes their mind.
        handledUrl.current = null;
        closeSheet();
      },
      closed: (shown) => {
        // The route is gone either way.
        sheetOpen.current = false;
        // A request that replaced the one it was showing stays, and gets the sheet again.
        if (requestRef.current !== shown) {
          bumpSheetGone();
          return;
        }
        handledUrl.current = null;
        setRequest(null);
      },
    }),
    [request, closeSheet, addToPool, showToast],
  );

  return <PairingSheetContext.Provider value={sheet}>{children}</PairingSheetContext.Provider>;
}
