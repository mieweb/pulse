import type { PulseErrorInfo } from '@mieweb/pulse-embed';

import { flushDraftWrites } from '@/features/editor/draft-writes';
import type { ExportedVideo } from '@/features/export/contract';
import { finalizeRecorders, recorderOnScreen } from '@/features/recorder/recorder-presence';

import type { DraftSeen } from './draft-sync';
import { syncEvents } from './draft-sync';
import type { FlowStore } from './flow-store';
import { onDraftsChanged, projectDocument, readDraft } from './library';
import { saveExportForHost } from './results';

/**
 * What the shell does to the flow from outside the reducer: keep it in step with the library
 * (draft-sync.ts), settle a take in flight before an exit counts, and hand the export to the host.
 * One per presentation, made outside the library gate so the host's `close` works even while the
 * gate shows its loading or recovery screen.
 */
export function createFlowController(store: FlowStore, requestId: string) {
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

  /** A take in flight saved, the editor's pending writes stored, and the reducer told. */
  async function settle(): Promise<void> {
    await finalizeRecorders();
    await flushDraftWrites().catch(() => {});
    observe();
  }

  const fail = (error: Omit<PulseErrorInfo, 'callId' | 'recoverable'>) =>
    store.dispatch({
      type: 'error',
      error: { recoverable: false, callId: '', requestId, ...error },
    });

  return {
    /**
     * The library gate passed: read the draft the entry opens and watch the library from now on.
     * Returns false when that draft doesn't exist.
     */
    attach(draftId: string | null): boolean {
      attached = true;
      if (draftId) {
        const seen = readDraft(draftId);
        if (!seen) return false;
        last = seen;
        store.open({ context: null, clipCount: seen.clipCount });
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
    /** Back: one screen down, or X at the root. */
    async back(): Promise<void> {
      await settle();
      store.dispatch({ type: 'back' });
    },
    /** X (and the VoiceOver escape): the keep/discard sheet with a take, else the end. */
    async close(): Promise<void> {
      await settle();
      store.dispatch({ type: 'close' });
    },
    /** The host's `close` (`pulse.cmd close {discard?}`): never the sheet. */
    async hostClose(discard: boolean): Promise<void> {
      await settle();
      store.dispatch({ type: 'hostClose', discard });
    },
    fail,
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
        fail({
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
