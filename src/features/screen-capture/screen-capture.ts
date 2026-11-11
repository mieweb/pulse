import { probe } from '@mieweb/pulse-editor';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useSyncExternalStore } from 'react';
import { Alert, AppState, Platform } from 'react-native';
import {
  addScreenRecordingListener,
  clearCache,
  getScreenRecordingSessionState,
  type RecordingError,
  retrieveLastGlobalRecording,
  type ScreenRecordingEvent,
  type ScreenRecordingFile,
  startGlobalRecording,
  stopGlobalRecording,
} from 'react-native-nitro-screen-recorder';

import { createDraft, draftTakesClips, segmentExists } from '@/db/drafts';
import { deleteSetting, getSetting, setSetting } from '@/db/settings';
import { addExternalClip } from '@/features/recorder/add-external-clip';
import { recorderOnScreen } from '@/features/recorder/recorder-presence';
import { type ToastOptions, useToast } from '@/features/toast/toast-provider';
import { uploadNotify } from '@/features/upload/notify';
import { describeError, formatBytes, formatSeconds } from '@/features/upload/upload-log';
import { deleteQuietly } from '@/utils/file-store';
import { haptics } from '@/utils/haptics';
import { importFailureCopy } from '@/utils/import-copy';

/**
 * Screen recording (plan: .devrun/plans/screen-recorder-spike.md §5). A take is the library's
 * global recording; the file it leaves becomes an ordinary clip through `addExternalClip`.
 *
 * One saved record and one recovery rule: the `screenCapture` settings row says a take of Pulse's
 * own is owed to a draft, and `reconcile()` is the only thing that turns a file into a clip. Files
 * reach it only through `row.sourcePath` (written by Stop or the Android ended event) or its own
 * single `retrieveLastGlobalRecording()`. A source is deleted only once the row's segment exists,
 * and the row only once its sources are gone, so any interruption (Pulse leaving, a kill, a crash)
 * is retried on the next `reconcile()`, never lost or added twice.
 */

/** Per platform, so one can be switched off: then the recorder's "+" is the plain import again
 * and nothing here runs. */
export const canRecordScreen = Platform.select({ ios: true, android: true, default: false });

const log = {
  info: (message: string) => console.info(`[screen] ${message}`),
  warn: (message: string) => console.warn(`[screen] ${message}`),
};

// --- Saved record --------------------------------------------------------------------------------

const ROW_KEY = 'screenCapture';

type Row = {
  /** Chosen when the take starts, so an import retried after a kill can't add the clip twice. */
  segmentId: string;
  /** The draft the take is for; null: a new one (an outside take added from Home). */
  draftId: string | null;
  createdAt: number;
  /** The recorder's mic toggle at the start (off: the sheet offered no Microphone). */
  mic: boolean;
  /** The file to import, once known. */
  sourcePath?: string;
  /** iOS: the broadcast's Microphone was off. */
  micOff?: boolean;
};

async function readRow(): Promise<Row | null> {
  const raw = await getSetting(ROW_KEY);
  try {
    return raw ? (JSON.parse(raw) as Row) : null;
  } catch {
    return null;
  }
}

function writeRow(row: Row): Promise<void> {
  return setSetting(ROW_KEY, JSON.stringify(row));
}

/** Change the row; with `segmentId`, only while it is still that take's. */
async function patchRow(patch: Partial<Row>, segmentId?: string): Promise<void> {
  const row = await readRow();
  if (row && (segmentId == null || row.segmentId === segmentId)) {
    await writeRow({ ...row, ...patch });
  }
}

async function dropRow(segmentId: string): Promise<void> {
  if ((await readRow())?.segmentId === segmentId) await deleteSetting(ROW_KEY);
}

// --- Files ---------------------------------------------------------------------------------------

function fileExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

function retrieve(): ScreenRecordingFile | null {
  try {
    return retrieveLastGlobalRecording() ?? null;
  } catch (e) {
    log.warn(`couldn't look for a recording: ${describeError(e)}`);
    return null;
  }
}

/** The take is done with: its file, the library's copies and leftovers, then its row. */
async function cleanUp(src: string | undefined, segmentId: string): Promise<void> {
  if (src) deleteQuietly(src);
  // iOS: every `retrieveLastGlobalRecording()` copies the App Group file here, never deleted.
  if (Platform.OS === 'ios') {
    try {
      new Directory(Paths.cache, 'ScreenRecordings').delete();
    } catch {}
  }
  try {
    clearCache();
  } catch (e) {
    log.warn(`couldn't clear the recorder's files: ${describeError(e)}`);
  }
  await dropRow(segmentId);
}

// --- Live state (memory only) --------------------------------------------------------------------

/** `live`: a take of Pulse's own is capturing. `stopping`: Stop asked, file settling. */
export type ScreenPhase = 'idle' | 'live' | 'stopping';

export type ScreenCaptureState = {
  phase: ScreenPhase;
  /** When the capture began (wall clock), for the timer; null until it has. */
  began: number | null;
  /** The draft the take, or its import, is for. */
  draftId: string | null;
  /** A screen recording is being converted into a draft. */
  importing: boolean;
  /** That conversion's progress (0–1); null until it reports. */
  progress: number | null;
  /** Record screen was tapped and the capture hasn't begun yet (a hint for the UI only). */
  starting: boolean;
};

let state: ScreenCaptureState = {
  phase: 'idle',
  began: null,
  draftId: null,
  importing: false,
  progress: null,
  starting: false,
};
const subscribers = new Set<() => void>();
function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

/** Read fresh after an await: another event may have moved it on. */
function phase(): ScreenPhase {
  return state.phase;
}

/**
 * Record screen was tapped: the next capture to begin within `REQUEST_TTL_MS` is this take. The
 * system sheet / consent dialog says nothing when dismissed (iOS), so a dismissed one just lets
 * this expire, and the next tap replaces it.
 */
let requested: { at: number; draftId: string; mic: boolean } | null = null;
const REQUEST_TTL_MS = 60_000;

/**
 * "Starting…" shows from the tap until the capture begins. iOS doesn't say when its sheet is
 * dismissed, so once Pulse is back in front it goes after this long without a start; the
 * request itself stays valid for `REQUEST_TTL_MS` in case the extension is slow.
 */
const STARTING_AFTER_RETURN_MS = 3000;
const STARTING_MAX_MS = 30_000;
let startingTimer: ReturnType<typeof setTimeout> | null = null;

function showStarting(draftId: string, forMs: number) {
  if (startingTimer) clearTimeout(startingTimer);
  setState({ starting: true, draftId });
  startingTimer = setTimeout(hideStarting, forMs);
}

function hideStarting() {
  if (startingTimer) clearTimeout(startingTimer);
  startingTimer = null;
  if (state.starting) setState({ starting: false });
}

/** Pulse is back in front (the sheet or consent dialog closed): no start soon means none. */
function onReturn() {
  if (state.starting && state.phase === 'idle' && requested) {
    showStarting(requested.draftId, STARTING_AFTER_RETURN_MS);
  }
}

function setState(patch: Partial<ScreenCaptureState>) {
  state = { ...state, ...patch };
  for (const notify of subscribers) notify();
}

export function useScreenCapture(): ScreenCaptureState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Whether a screen take or its import is using this draft: the recorder mustn't drop it as empty. */
export function screenCaptureHolds(draftId: string): boolean {
  return state.draftId === draftId && (state.phase !== 'idle' || state.importing);
}

// --- Messages ------------------------------------------------------------------------------------

let showToast: ((toast: ToastOptions) => void) | null = null;

const error = (title: string, message: string) => showToast?.({ kind: 'error', title, message });
const toast = {
  startFailed: (message = 'Try again.') => error('Couldn’t start screen recording', message),
  noFile: () =>
    error(
      'Couldn’t find the screen recording',
      'Your phone didn’t hand it to Pulse. Record it again.',
    ),
  tooShort: () =>
    error('Couldn’t add the screen recording', 'It was too short. Record for at least a second.'),
  lost: () =>
    error('Couldn’t save the screen recording', 'It stopped when Pulse closed. Record it again.'),
  noVoice: () =>
    showToast?.({
      kind: 'warning',
      title: 'Recorded without your voice',
      message: 'To talk over it next time, tap Microphone before Start Broadcast.',
    }),
};

// --- Reconcile -----------------------------------------------------------------------------------

/** Rows from before this launch: an Android take can't outlive the process that started it. */
const PROCESS_STARTED = Date.now();
/** iOS: a row whose file never came (the sheet was killed, the extension died) is forgotten. */
const IOS_ROW_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A take shorter than this isn't worth a clip. */
const MIN_TAKE_MS = 1000;

let flight: Promise<boolean> | null = null;
/** A failed import's alert is up: nothing runs until Discard or Try again. */
let awaitingChoice = false;

/**
 * Turn a waiting screen recording into a clip, or clean up after one. Single-flight: a call while
 * one runs gets that run. Resolves true while a take's file is owed but not there (iOS).
 */
export function reconcile(): Promise<boolean> {
  if (!canRecordScreen) return Promise.resolve(false);
  flight ??= run()
    .catch((e: unknown) => {
      log.warn(`reconcile failed: ${describeError(e)}`);
      return false;
    })
    .finally(() => {
      flight = null;
    });
  return flight;
}

async function run(): Promise<boolean> {
  if (state.phase !== 'idle' || awaitingChoice || AppState.currentState === 'background') {
    return false;
  }
  const row = await readRow();

  // An earlier run added the clip and stopped before cleaning up.
  if (row && (await segmentExists(row.segmentId))) {
    log.info('clip already in its draft; cleaning up');
    await cleanUp(row.sourcePath, row.segmentId);
    return false;
  }

  let src = row?.sourcePath && fileExists(row.sourcePath) ? row.sourcePath : null;
  let micOff = row?.micOff ?? false;
  if (!src) {
    const file = retrieve();
    if (file) {
      src = file.path;
      micOff = row?.micOff ?? (Platform.OS === 'ios' && !file.enabledMicrophone);
      log.info(
        `found ${file.name} (${formatBytes(file.size)}, ${formatSeconds(file.duration * 1000)})`,
      );
    }
  }

  if (!src) {
    if (!row) return false;
    // Android: an idle take with no file is gone (a kill, or a stop that failed).
    if (Platform.OS === 'android') {
      log.warn('the take left no file');
      await cleanUp(undefined, row.segmentId);
      if (row.createdAt < PROCESS_STARTED) toast.lost();
      else toast.noFile();
      return false;
    }
    if (Date.now() - row.createdAt > IOS_ROW_MAX_AGE_MS) {
      log.info('no recording came in a day; forgetting the take');
      await dropRow(row.segmentId);
      return false;
    }
    return true;
  }

  // A file with no take of Pulse's own: started from Control Center.
  if (!row) {
    offer(src, micOff);
    return false;
  }
  if (row.sourcePath !== src) await patchRow({ sourcePath: src, micOff }, row.segmentId);

  if (await tooShort(src)) {
    log.warn('too short to keep');
    await cleanUp(src, row.segmentId);
    toast.tooShort();
    return false;
  }

  // E4 only when the sheet offered Microphone (the recorder's mic was on) and it was left off.
  await importTake(row, src, micOff && row.mic);
  return false;
}

async function tooShort(src: string): Promise<boolean> {
  try {
    if (new File(src).size === 0) return true;
    const info = await probe(src);
    const ms = info.video?.durationMs ?? 0;
    return ms > 0 && ms < MIN_TAKE_MS;
  } catch {
    // Unreadable: the conversion rejects it with the reason.
    return false;
  }
}

/** Invariant 4: only while Pulse is active; leaving cancels it and keeps the row and the file. */
async function importTake(row: Row, src: string, noVoice: boolean): Promise<void> {
  const started = Date.now();
  log.info(`adding to ${row.draftId ? 'its draft' : 'a new draft'}`);
  setState({ importing: true, progress: null, draftId: row.draftId });
  const abort = new AbortController();
  const sub = AppState.addEventListener('change', (next) => {
    if (next === 'background') abort.abort();
  });
  try {
    const result = await addExternalClip(src, () => draftFor(row), row.segmentId, {
      signal: abort.signal,
      onProgress: (progress) => setState({ progress }),
    });
    if (result.status === 'cancelled') {
      log.warn(`cancelled after ${formatSeconds(Date.now() - started)}: Pulse left`);
    } else if (result.status === 'rejected') {
      importFailed(result.why, src, row.segmentId);
    } else {
      log.info(`added in ${formatSeconds(Date.now() - started)}`);
      await cleanUp(src, row.segmentId);
      if (noVoice) toast.noVoice();
    }
  } catch (e) {
    const why = describeError(e);
    log.warn(`failed: ${why}`);
    importFailed(why, src, row.segmentId);
  } finally {
    sub.remove();
    setState({ importing: false, progress: null, draftId: null });
  }
}

/** The row's draft, or a new one when it has gone (an empty draft is dropped when its recorder
 * closes) or is uploading. A new one is written to the row, so a retry lands in it too. */
async function draftFor(row: Row): Promise<string> {
  if (row.draftId && (await draftTakesClips(row.draftId))) return row.draftId;
  const id = await createDraft();
  await patchRow({ draftId: id }, row.segmentId);
  setState({ draftId: id });
  log.info('added to a new draft');
  return id;
}

/** The file is kept until the person chooses: a conversion can fail for a reason that passes. */
function importFailed(why: string, src: string, segmentId: string) {
  awaitingChoice = true;
  Alert.alert(
    'Couldn’t add the screen recording',
    importFailureCopy(why, 'screen'),
    [
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          awaitingChoice = false;
          log.info('discarded');
          void cleanUp(src, segmentId);
        },
      },
      {
        text: 'Try again',
        onPress: () => {
          awaitingChoice = false;
          void reconcile();
        },
      },
    ],
    { cancelable: false },
  );
}

/**
 * A recording started outside Pulse (Control Center), offered once: the App Group original goes
 * now, and the copy in `src` waits for Add (the next take's clean-up deletes it otherwise).
 */
function offer(src: string, micOff: boolean) {
  if (!showToast) return;
  if (Platform.OS === 'ios') {
    try {
      clearCache();
    } catch {}
  }
  log.info('a recording started outside Pulse is waiting; offered');
  showToast({
    kind: 'info',
    title: 'Screen recording ready',
    message: recorderOnScreen() ? 'Add it to this draft?' : 'Add it to a new draft?',
    action: { label: 'Add', onPress: () => void addOffered(src, micOff) },
  });
}

async function addOffered(src: string, micOff: boolean) {
  // A take of Pulse's own came first.
  if (state.phase !== 'idle' || (await readRow())) return;
  try {
    if (!fileExists(src)) throw new Error('the offered file is gone');
    const recorder = recorderOnScreen();
    const draftId = recorder ? await recorder.ensureDraft() : null;
    log.info(`Add: to ${draftId ? 'the open draft' : 'a new draft'}`);
    await writeRow({
      segmentId: `${draftId ?? 'screen'}-${Date.now()}`,
      draftId,
      createdAt: Date.now(),
      mic: true,
      sourcePath: src,
      micOff,
    });
  } catch (e) {
    log.warn(`Add failed: ${describeError(e)}`);
    toast.noFile();
    return;
  }
  await reconcile();
}

// --- A take --------------------------------------------------------------------------------------

/** How long Stop waits for the file to settle before looking for it. */
const STOP_SETTLE_MS = 1500;
/** iOS: the extension finishes writing after the capture ends (a 23 s take took over 3 s on an
 * iPhone 17 Pro Max), so look again every second for this long before saying there's no file. */
const IOS_RETRY_MS = 1000;
const IOS_WAIT_MS = 20_000;

/**
 * Record screen: asks for a take for the recorder's draft (`draft` makes it if needed). Nothing is
 * saved until the capture begins. `enableMic`: the recorder's mic toggle.
 */
export async function startScreenCapture(
  draft: () => Promise<string>,
  enableMic: boolean,
): Promise<void> {
  if (!canRecordScreen || state.phase !== 'idle' || state.importing) return;
  try {
    const draftId = await draft();
    requested = { at: Date.now(), draftId, mic: enableMic };
    showStarting(draftId, STARTING_MAX_MS);
    // Android: the recording's notification (and its Stop) needs it; a denial still records.
    if (Platform.OS === 'android') await uploadNotify.ensurePermission();
    log.info(`start (mic ${enableMic ? 'on' : 'off'})`);
    startGlobalRecording({ options: { enableMic }, onRecordingError });
  } catch (e) {
    requested = null;
    hideStarting();
    log.warn(`start failed: ${describeError(e)}`);
    toast.startFailed();
  }
}

export async function stopScreenCapture(): Promise<void> {
  if (state.phase !== 'live') return;
  setState({ phase: 'stopping' });
  log.info('stop');
  let file: ScreenRecordingFile | undefined;
  try {
    file = await stopGlobalRecording({ settledTimeMs: STOP_SETTLE_MS });
  } catch (e) {
    log.warn(`stop failed: ${describeError(e)}`);
  }
  if (file) {
    await patchRow({
      sourcePath: file.path,
      micOff: Platform.OS === 'ios' && !file.enabledMicrophone,
    });
  }
  // The ended event may have finished the take meanwhile; on Android a long take still being
  // finalized ends with it.
  if (phase() !== 'stopping') return;
  if (Platform.OS === 'android' && !file && getScreenRecordingSessionState() === 'recording')
    return;
  finishTake();
}

function onRecordingError(error: RecordingError) {
  log.warn(`${error.name}: ${error.message}`);
  // The take ended in an error: whatever file it left is picked up.
  if (state.phase !== 'idle') {
    finishTake();
    return;
  }
  requested = null;
  hideStarting();
  // Android's consent dialog cancelled: nothing to say.
  if (/permission denied/i.test(error.message)) return;
  toast.startFailed(
    error.name === 'BROADCAST_ALREADY_ACTIVE'
      ? 'Your screen is already being recorded or mirrored.'
      : undefined,
  );
}

/**
 * Every capture's events (the library's "initiated elsewhere" filter drops our own iOS `ended`).
 * A capture that begins with no fresh Record screen tap (AirPlay, a Control Center start) isn't a
 * take; its file, if any, goes through the pick-up's offer.
 */
function onRecordingEvent(event: ScreenRecordingEvent) {
  if (event.type !== 'global') return;
  if (event.reason === 'began') {
    const req = requested;
    if (state.phase !== 'idle' || !req || Date.now() - req.at > REQUEST_TTL_MS) return;
    requested = null;
    const now = Date.now();
    log.info('capture began');
    // Felt, not just seen: the take is live (haptics mute once it is).
    haptics.tap();
    hideStarting();
    setState({ phase: 'live', began: now, draftId: req.draftId });
    void writeRow({
      // Its own form, so it can't meet a camera clip's `{draftId}-{ms}` saved in the same ms.
      segmentId: `${req.draftId}-screen-${now}`,
      draftId: req.draftId,
      createdAt: now,
      mic: req.mic,
    }).catch((e: unknown) => log.warn(`couldn't save the take: ${describeError(e)}`));
  } else if (state.phase === 'live' || state.phase === 'stopping') {
    log.info('capture ended');
    void onEnded();
  }
}

async function onEnded() {
  // Android forgets the file with the process: noted now (JS still runs in the background), so a
  // kill before Pulse is back still finds it.
  if (Platform.OS === 'android') {
    const file = retrieve();
    if (file) await patchRow({ sourcePath: file.path });
  }
  finishTake();
}

function finishTake() {
  if (state.phase === 'idle') return;
  setState({ phase: 'idle', began: null });
  void afterTake();
}

/** The file of a take that just ended: imported now, or E6 when iOS never hands it over (its row
 * stays: the extension may still deliver it). Android settles this inside `run()`. */
async function afterTake() {
  const until = Date.now() + IOS_WAIT_MS;
  while (await reconcile()) {
    if (Date.now() >= until) {
      log.warn('no file after the take');
      toast.noFile();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, IOS_RETRY_MS));
  }
}

/**
 * Mounted once at the root, inside the toast provider: the listener for the live state, the
 * pick-up on launch and on every return to Pulse, and the toasts.
 */
export function ScreenCaptureLifecycle(): null {
  const { showToast: show } = useToast();
  useEffect(() => {
    if (!canRecordScreen) return;
    showToast = show;
    return () => {
      showToast = null;
    };
  }, [show]);

  useEffect(() => {
    if (!canRecordScreen) return;
    const removeListener = addScreenRecordingListener({
      listener: onRecordingEvent,
      ignoreRecordingsInitiatedElsewhere: false,
    });
    // Android can say a take is live (JS reloaded under it); iOS can't.
    if (Platform.OS === 'android' && getScreenRecordingSessionState() === 'recording') {
      setState({ phase: 'live', began: Date.now() });
    }
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      onReturn();
      void reconcile();
    });
    void reconcile();
    return () => {
      removeListener();
      sub.remove();
    };
  }, []);
  return null;
}
