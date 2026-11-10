import { addEventListener, getInitialURL } from 'expo-linking';
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
import { findOpenDraftForContext } from '@/db/drafts';
import { isOnboardingComplete } from '@/db/settings';
import { flushDraftWrites } from '@/features/editor/draft-writes';
import { offerRecorderPlace } from '@/features/recorder/link-place';
import {
  finalizeRecorders,
  recorderOnScreen,
  recordersGone,
} from '@/features/recorder/recorder-presence';
import { useToast } from '@/features/toast/toast-provider';
import { hostOf, shortHost } from '@/utils/format';
import { createPresence } from '@/utils/presence';

import { CAPABILITIES_REJECTION_MESSAGE, checkCapabilities } from './capabilities';
import { expiresAtMs, expiresLater } from './capability-token';
import { checkDeferredPairing } from './deferred-pairing';
import { pairingLinkParams, parseUploadDeepLink, type UploadDeepLink } from './deep-link';
import { rememberHandledLink, wasLinkHandled } from './handled-links';
import { LINK_HOST } from './link-host';
import {
  linkExpiredToast,
  linkRefusedToast,
  placeOpenedToast,
  recorderFailedToast,
} from './link-messages';
import { createRecorderOpener, type RecorderTarget } from './open-recorder';
import { createLinkGate, pairLink, screenLink } from './pair-link';
import { checkToken } from './token-check';
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

/** The pairing sheet (`/pair`) while mounted, which lasts until its closing animation ends. */
export const pairingSheetPresence = createPresence();

/** Longest a link's recorder waits for a closing screen; past it, it goes ahead. */
const SCREEN_GONE_TIMEOUT_MS = 1500;

/** How long the recorder a link pushes has to mount and take its place from memory. */
const HANDOFF_MS = 5000;

/** How long a place paired during the welcome screen waits for the first recording, at most. */
const WELCOME_OFFER_MS = 30 * 60_000;

/** Opens the recorder for a link's place, one link at a time (see `showRecorder`). */
const openRecorder = createRecorderOpener({
  sheetGone: () => pairingSheetPresence.whenGone(SCREEN_GONE_TIMEOUT_MS),
  finalizeRecorders,
  flushDraftWrites,
  findOpenDraft: findOpenDraftForContext,
  recorderOnScreen,
  canDismiss: () => router.canDismiss(),
  dismissAll: () => router.dismissAll(),
  recordersGone: () => recordersGone(SCREEN_GONE_TIMEOUT_MS),
  offerPlace: (place) => offerRecorderPlace(place, Date.now() + HANDOFF_MS),
  // `forLink` only marks the recorder as a link's; its place is handed over in memory.
  push: (draftId) =>
    router.push({
      pathname: '/recorder',
      params: { ...(draftId ? { draftId } : {}), forLink: '1' },
    }),
});

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
 * A link that names the place its upload is for (`ref`, deep-link.ts) does more. It is refused
 * when it has already expired, and ignored when it is an old launch link handed to the app again
 * (`screenLink`). Its server is asked to accept its token before it takes over what the place has
 * (`pairLink`): until a draft claims it the place has one destination, which a newer link
 * replaces. And the recorder opens for it — on the place's unsent draft, or a new one named with
 * the link's `name` (`showRecorder`).
 *
 * On the first launch after a store install it also picks up the link the `/pulse/open` page
 * handed over (deferred-pairing.ts): Android's install referrer goes through the same
 * confirmation; iOS shows the sheet's paste variant.
 *
 * It also starts the upload manager for the app's lifetime: the launch check,
 * and the toast an upload failure shows in the foreground.
 */
export function UploadDeepLinkProvider({ children }: { children: React.ReactNode }) {
  // Which deliveries of a link are acted on: not one reported twice at once, nor a plain link
  // opened again (its row may be spent).
  const [gate] = useState(() => createLinkGate());
  const { showToast } = useToast();
  const [request, setRequestState] = useState<PairingRequest | null>(null);
  // The current request for `closed`, which can run before this render's effects would update a
  // mirror: kept in step at every set instead.
  const requestRef = useRef<PairingRequest | null>(null);
  const setRequest = useCallback((next: PairingRequest | null) => {
    requestRef.current = next;
    setRequestState(next);
  }, []);
  const sheetOpen = useRef(false);
  // Bumped when the sheet goes away while a newer request waits, so the effect below shows it.
  const [sheetGone, bumpSheetGone] = useReducer((n: number) => n + 1, 0);
  const navigationReady = !!useRootNavigationState()?.key;
  // A place link's recorder, opened once the navigator can take it (see the effect below).
  const recorderTarget = useRef<RecorderTarget | null>(null);
  const [recorderAsked, askRecorder] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const target = recorderTarget.current;
    if (!target || !navigationReady) return;
    recorderTarget.current = null;
    openRecorder(target);
  }, [recorderAsked, navigationReady]);

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
  }, [setRequest]);

  const addToPool = useCallback(
    // `trusted`: paired without the sheet. `trustNotSaved`: "Don't ask again" was ticked but
    // didn't save.
    (link: UploadDeepLink, trusted = false, trustNotSaved = false) => {
      const host = shortHost(hostOf(link.server));
      const { place } = link;
      // Added to the device-wide pool (not a single slot) — any draft can pick it at upload
      // time, and several servers can be paired at once. A place has one row there.
      void pairLink(link, {
        checkCapabilities,
        checkToken: (asked) =>
          checkToken({ server: asked.server, artifactId: asked.artifactId, token: asked.token }),
        save: (paired) =>
          addDestination(
            { server: paired.server, token: paired.token, artifactId: paired.artifactId },
            paired.place && {
              ref: paired.place.ref,
              label: paired.place.label,
              app: paired.place.app,
              returnUrl: paired.place.returnUrl,
            },
            // An older link for the place, opened late, never takes the place of a newer one.
            (stored) => expiresLater(paired.token, stored),
          ),
        remember: rememberHandledLink,
      })
        .then(async (result) => {
          if (!result.ok) {
            // Nothing was persisted: the same link opened again, even at once, is a new try.
            gate.release();
            if (result.reason === 'refused') {
              showToast({ kind: 'error', ...linkRefusedToast({ label: place?.label, host }) });
              return;
            }
            showToast({
              kind: 'error',
              title: 'Couldn’t connect',
              message:
                CAPABILITIES_REJECTION_MESSAGE[
                  result.reason === 'not-saved' ? 'unreachable' : result.reason
                ],
            });
            return;
          }
          // The same link (or place) again keeps its row id: open screens reload its fresh token.
          reloadDestinationTokens();
          if (place) {
            const opened = (draftId: string | null) =>
              showToast({
                kind: 'info',
                ...placeOpenedToast({
                  label: place.label,
                  host,
                  draftOpen: draftId !== null,
                  trustNotSaved,
                }),
              });
            // A link for a place opens the recorder on it.
            if (await isOnboardingComplete().catch(() => true)) {
              recorderTarget.current = {
                server: link.server,
                ref: place.ref,
                name: place.name,
                opened,
                failed: () => showToast({ kind: 'error', ...recorderFailedToast(host) }),
              };
              askRecorder();
              return;
            }
            // While the welcome screen is up it stays up, and the destination waits in the pool
            // like any other — but the place waits too, for the first recording made after it
            // (Continue goes straight to the recorder), while the link still works.
            offerRecorderPlace(
              {
                context: { server: link.server, ref: place.ref },
                name: place.name,
                onTaken: () => opened(null),
              },
              Math.min(expiresAtMs(link.token) ?? Infinity, Date.now() + WELCOME_OFFER_MS),
            );
          }
          // A trusted server pairs without the sheet, so the toast says why nothing asked.
          showToast({
            kind: trusted ? 'info' : 'success',
            title: `Connected to ${host}`,
            message: trusted
              ? 'You chose not to be asked for this server. Pick it when you upload.'
              : trustNotSaved
                ? 'Pick it when you upload. Pulse couldn’t save “Don’t ask again”, so its next link asks first.'
                : 'Pick it when you upload.',
          });
        })
        .catch(() => {
          // Let the same link be retried — silently swallowing this would leave the user stuck
          // with no path forward but to restart the app.
          gate.release();
          showToast({
            kind: 'error',
            title: 'Couldn’t connect',
            message: CAPABILITIES_REJECTION_MESSAGE.unreachable,
          });
        });
    },
    [gate, showToast],
  );

  // A link in either form (`pulsecam://` or the https link): validate it, then ask the sheet to
  // confirm its server, unless the person ticked "Don't ask again" for it. Linking links and
  // Android's install referrer share it. `launch`: it is the link the app was launched with.
  const confirmLink = useCallback(
    (pairingUrl: string, launch = false) => {
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
      void screenLink(link, { launch, nowMs: Date.now(), wasHandled: wasLinkHandled })
        .then((screened) => {
          // An old launch link the system handed back: not the person's doing, so nothing shows.
          if (screened === 'replayed') return;
          if (screened === 'expired') {
            void rememberHandledLink(link.artifactId).catch(() => {});
            showToast({
              kind: 'error',
              ...linkExpiredToast({
                label: link.place?.label,
                host: shortHost(hostOf(link.server)),
              }),
            });
            return;
          }
          return isTrustedServer(link.server)
            .catch(() => false)
            .then((trusted) => {
              if (trusted) addToPool(link, true);
              else setRequest({ kind: 'confirm', link, host: hostOf(link.server) });
            });
        })
        .catch(() => {});
    },
    [addToPool, setRequest, showToast],
  );

  const handleUrl = useCallback(
    (url: string, launch = false) => {
      const params = pairingLinkParams(url, LINK_HOST);
      if (params === null) return;
      // A link for a place opened again reopens that place's recorder. A plain link opened again
      // in this session is ignored, as before (cancel or a failure clears that).
      const parsed = parseUploadDeepLink(url, LINK_HOST);
      if (!gate.admit(url, parsed.ok && !!parsed.link.place)) return;
      // Bare `pulsecam://` (Android's upload notification opens it) only brings the app forward.
      if (params === '') return;
      // Development only: `pulsecam://bench?...` opens the git-excluded bench screen (.devrun/), a
      // route rather than a pairing link, which the parser would reject and toast on.
      if (__DEV__ && url.startsWith('pulsecam://bench')) return;

      // `+native-intent` keeps the router on the current screen for both link forms, so the sheet
      // opens over whatever is up (recorder, export, onboarding…) and closing it returns there.
      confirmLink(url, launch);
    },
    [confirmLink, gate],
  );

  // Every link opened while the app runs, each time — the same URL again included, which a link
  // for a place needs (`useLinkingURL` only reports a change).
  useEffect(() => {
    const sub = addEventListener('url', ({ url }) => handleUrl(url));
    return () => sub.remove();
  }, [handleUrl]);

  // The link the app was launched with, once. Then, on the first launch after a store install, the
  // pairing link the `/pulse/open` page handed over — skipped when this launch came from a pairing
  // link, which already carries the pairing.
  const launchChecked = useRef(false);
  useEffect(() => {
    if (launchChecked.current) return;
    launchChecked.current = true;
    void getInitialURL()
      .catch(() => null)
      .then((initial) => {
        if (initial) handleUrl(initial, true);
        return checkDeferredPairing(!!initial && !!pairingLinkParams(initial, LINK_HOST));
      })
      .then((found) => {
        if (found?.kind === 'link') confirmLink(found.url);
        if (found?.kind === 'pasteboard') setRequest({ kind: 'paste' });
      })
      .catch(() => {});
  }, [handleUrl, confirmLink, setRequest]);

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
        gate.release();
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
        gate.release();
        setRequest(null);
      },
    }),
    [request, gate, closeSheet, addToPool, setRequest, showToast],
  );

  return <PairingSheetContext.Provider value={sheet}>{children}</PairingSheetContext.Provider>;
}
