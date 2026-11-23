import type { PulseErrorInfo } from '@mieweb/pulse-embed';

import { flushDraftWrites } from '@/features/editor/draft-writes';
import type { ExportedVideo, SentVideo } from '@/features/export/contract';
import { finalizeRecorders, recorderOnScreen } from '@/features/recorder/recorder-presence';

import type { DraftSeen } from './draft-sync';
import { syncEvents } from './draft-sync';
import type { FlowStore } from './flow-store';
import { onDraftsChanged, projectDocument, readDraft } from './library';
import type { UiFields } from './messaging';
import { saveExportForHost } from './results';

/**
 * How long a failure waits for a take in flight to save before the flow ends anyway: a failure can
 * come from the recorder itself, and a recorder that never finishes must not hold the result.
 */
export const FAIL_SETTLE_MS = 5_000;

/** `work`, or `ms` going by, whichever is first; never rejects. */
function within(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    work
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/**
 * What the shell does to the flow from outside the reducer: keep it in step with the library
 * (draft-sync.ts), settle a take in flight before an exit counts, and hand the export to the host.
 * One per presentation, made outside the library gate so the host's `close` works even while the
 * gate shows its loading or recovery screen.
 */
export function createFlowController(
  store: FlowStore,
  requestId: string,
  ui: (fields: UiFields) => void = () => {},
) {
  let last: DraftSeen | null = null;
  // The library gate has passed: before that the library may not be readable.
  let attached = false;
  let using = false;

  /** Read the flow's draft (or the one the recorder just made) and feed what changed. */
  function observe(draftId?: string | null): void {
    if (!attached) return;
    const id = draftId ?? store.state().draftId ?? recorderOnScreen()?.draftId ?? null;
    if (!id) return;
    let seen: DraftSeen | null;
    try {
      seen = readDraft(id);
    } catch (e) {
      console.warn(`[embed] couldn't read draft ${id}`, e);
      return;
    }
    for (const event of syncEvents(store.state(), seen, last)) store.dispatch(event);
    if (seen) last = seen;
  }

  const topKey = () => store.getSnapshot().items.at(-1)?.key;

  /** A take in flight saved, the editor's pending writes stored, and the reducer told. */
  async function settle(): Promise<void> {
    await finalizeRecorders();
    await flushDraftWrites().catch(() => {});
    observe();
  }

  /**
   * End the flow `failed{error}` (a JS error in a screen, a library it can't open, a hand-off that
   * failed), once a take in flight has saved, as the other exits do, so the result names the
   * draft it landed in. Waits at most `FAIL_SETTLE_MS`.
   */
  async function fail(error: Omit<PulseErrorInfo, 'callId' | 'recoverable'>): Promise<void> {
    await within(settle(), FAIL_SETTLE_MS);
    store.dispatch({
      type: 'error',
      error: { recoverable: false, callId: '', requestId, ...error },
    });
  }

  return {
    /**
     * The library gate passed: read the draft the entry opens (its clips and the host place it is
     * for) and watch the library from now on. Returns false when that draft doesn't exist.
     */
    attach(draftId: string | null): boolean {
      attached = true;
      if (draftId) {
        const seen = readDraft(draftId);
        if (!seen) return false;
        last = seen;
        // The draft's own place (and host data): what the flow's result names as its context.
        store.open({ context: seen.context, clipCount: seen.clipCount });
      }
      return true;
    },
    /** Watch the library while the screens are up; returns the function that stops. */
    watch(): () => void {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const stop = onDraftsChanged(() => {
        // One read for a burst of row changes (a take writes the draft and its clip).
        timer ??= setTimeout(() => {
          timer = null;
          observe();
        }, 0);
      });
      return () => {
        stop();
        if (timer) clearTimeout(timer);
      };
    },
    observe,
    /**
     * Back: one screen down, or X at the root. It acts only if the screen it was asked from is
     * still on top after the settle, so a double tap (or a tap plus a native pop) moves one level.
     */
    async back(): Promise<void> {
      const from = topKey();
      await settle();
      if (topKey() === from) store.dispatch({ type: 'back' });
    },
    /** X (and the VoiceOver escape): the keep/discard sheet with a take, else the end. */
    async close(): Promise<void> {
      const from = topKey();
      await settle();
      if (topKey() === from) store.dispatch({ type: 'close' });
    },
    /**
     * UIKit popped screens itself (a VoiceOver escape or anything else UINavigationController
     * does on its own): step the reducer down until `key` is off the stack, so both agree.
     */
    async nativePopped(key: string): Promise<void> {
      // Bounded: each pass removes a screen or the loop stops.
      for (let n = store.getSnapshot().items.length; n > 0; n--) {
        if (!store.getSnapshot().items.some((i) => i.key === key)) return;
        const from = topKey();
        await settle();
        if (topKey() !== from) continue;
        if (store.getSnapshot().items.length <= 1) return;
        store.dispatch({ type: 'back' });
      }
    },
    /** The host's `close` (`pulse.cmd close {discard?}`): never the sheet. */
    async hostClose(discard: boolean): Promise<void> {
      await settle();
      store.dispatch({ type: 'hostClose', discard });
    },
    fail,
    /** Send ('pulse' mode): the job is queued; the flow ends `completed{mode:'pulse'}`. */
    sent(sent: SentVideo): void {
      store.dispatch({
        type: 'send',
        sentAt: sent.sentAt,
        clientKey: sent.clientKey,
        draftKey: sent.draftKey,
        ...(sent.confirmedAt !== undefined ? { confirmedAt: sent.confirmedAt } : null),
      });
    },
    /**
     * Export's Send started (`true`: the merge, then the host's confirm) or stopped without going
     * (`false`). Meanwhile the host's close waits, as it waits for a take: a clock action must
     * not succeed behind a flow that already ended. The facade hears it too (`pulse.ui sending`),
     * so its close watchdog gives the Send its own deadline instead of 5 s.
     */
    sending(busy: boolean): void {
      store.dispatch({ type: busy ? 'sendStarted' : 'sendStopped' });
      // What the reducer holds: a Send it didn't take (not on Export) holds nothing.
      ui({ sending: store.state().sending });
    },
    /**
     * Export's video is ready for the flow's draft (merged now, or the saved export still
     * matching): the flow's stage is `exported` until a clip changes.
     */
    exportReady(draftId: string): void {
      if (store.state().draftId === draftId) store.dispatch({ type: 'merged' });
    },
    /** [Keep draft] after a failed host confirm: the flow ends `closed`, the draft unsent. */
    keepDraft(): void {
      store.dispatch({ type: 'keepDraft' });
    },
    /** "Use this video" ('file' mode): copy the export for the host, then end the flow. */
    async useVideo(video: ExportedVideo): Promise<void> {
      if (using) return; // one copy per tap
      using = true;
      try {
        const files = await saveExportForHost({
          requestId,
          exportPath: video.path,
          project: () => projectDocument(video.draftId),
        });
        store.dispatch({
          type: 'useVideo',
          export: files.export,
          durationMs: video.durationMs,
          project: files.project,
        });
      } catch (e) {
        console.warn('[embed] couldn’t hand the video to the app', e);
        await fail({
          code: 'export.failed',
          message: e instanceof Error ? e.message : String(e),
          draftId: video.draftId,
        });
      } finally {
        using = false;
      }
    },
  };
}

export type FlowController = ReturnType<typeof createFlowController>;
