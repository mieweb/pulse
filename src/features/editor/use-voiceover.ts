import type { PreviewStatus } from '@mieweb/pulse-editor';
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { toVoiceoverMix } from '@/core/media/voiceover';
import {
  addVoiceoverTake,
  setAudioTrackMuted,
  undoVoiceoverTake,
  voiceoverSettingsQuery,
  voiceoverTakesQuery,
} from '@/db/voiceovers';
import { claimAudioSession } from '@/utils/audio-session';
import { deleteQuietly } from '@/utils/file-store';
import { userMessage } from '@/utils/user-message';

import type { PreviewTransport } from './use-preview-transport';
import { VoiceoverSession, type VoiceoverPhase } from './voiceover-session';

/** Microphone lifetime belongs to the visible voiceover workflow, never a hidden editor. */
export function useVoiceover(
  draftId: string,
  ctl: PreviewTransport['ctl'],
  enabled: boolean,
  focused: boolean,
) {
  const { data: takes } = useLiveQuery(voiceoverTakesQuery(draftId), [draftId]);
  const { data: settings } = useLiveQuery(voiceoverSettingsQuery(draftId), [draftId]);
  const sourceMuted = settings[0]?.sourceAudioMuted ?? false;
  const voiceoverMuted = settings[0]?.voiceoverMuted ?? false;
  const mix = useMemo(
    () => toVoiceoverMix({ takes, sourceMuted, voiceoverMuted }),
    [takes, sourceMuted, voiceoverMuted],
  );
  const [phase, setPhase] = useState<VoiceoverPhase>('preparing');
  const [error, setError] = useState<string | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const undoing = useRef(false);
  const session = useRef<VoiceoverSession | null>(null);

  useEffect(() => {
    if (!enabled || !focused) return;
    let live = true;
    claimAudioSession();
    ctl.pause();
    const native = () => {
      if (!ctl.ref) throw new Error('Wait for the video preview to load, then try again.');
      return ctl.ref;
    };
    const current = new VoiceoverSession({
      prepare: () => native().prepareVoiceover(),
      start: async () => {
        // A fling or unfinished seek cannot race the native capture/playback anchor.
        if (ctl.dragging || ctl.afterBuild != null || ctl.inflight || ctl.pending != null)
          throw new Error('Let the timeline settle, then hold to record.');
        return native().startVoiceover();
      },
      stop: () => native().stopVoiceover(),
      cancel: () => ctl.ref?.cancelVoiceover(),
      discard: (take) => deleteQuietly(take.uri),
      save: async (take, recordStartMs) => {
        const trimEndMs = Math.min(
          take.durationMs,
          take.sourceStartMs + (take.endMs - take.startMs),
        );
        await addVoiceoverTake({
          draftId,
          cacheUri: take.uri,
          startMs: take.startMs,
          recordStartMs,
          durationMs: take.durationMs,
          trimStartMs: take.sourceStartMs,
          trimEndMs,
        });
        console.info('[voiceover] capture timing', {
          startMs: take.startMs,
          endMs: take.endMs,
          pressToPlaybackMs: take.pressToPlaybackMs,
          pressToCaptureMs: take.pressToCaptureMs,
          stopAlignmentMs: take.stopAlignmentMs,
          audioVideoOffsetMs: take.audioVideoOffsetMs,
        });
        if (live) {
          // New audio options rebuild the composition; place after that swap too.
          ctl.endTrim(take.startMs + trimEndMs - take.sourceStartMs);
          await ctl.waitUntilSettled();
        }
      },
      changed: (next, failure) => {
        if (!live) return;
        setPhase(next);
        setError(failure ? userMessage(failure, 'Try again.', 'record voiceover') : null);
      },
    });
    session.current = current;
    void current.prepare();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') return;
      // iOS's microphone permission dialog briefly makes the app inactive. No take exists
      // during preparation; allow the answer to finish, while real backgrounding still cancels.
      if (state === 'inactive' && current.phase === 'preparing') return;
      current.interrupt(new Error('Recording interrupted. Tap Retry before recording again.'));
      ctl.pause();
    });
    return () => {
      live = false;
      sub.remove();
      current.dispose();
      if (session.current === current) session.current = null;
    };
  }, [draftId, ctl, enabled, focused]);

  const busy = phase === 'starting' || phase === 'recording' || phase === 'saving';
  const release = () => session.current?.release() ?? Promise.resolve();
  return {
    takes,
    mix,
    phase,
    error,
    busy,
    undoBusy,
    canUndo:
      !undoBusy &&
      (phase === 'ready' || phase === 'saving') &&
      (takes.length > 0 || phase === 'saving'),
    sourceMuted,
    voiceoverMuted,
    retry: () => void session.current?.retry(),
    press: () => {
      const recordStartMs = ctl.getPlayheadMs();
      if (!undoing.current && recordStartMs < ctl.totalMs - 1)
        session.current?.press(recordStartMs);
    },
    release: () => void release(),
    onTime: (ms: number, playing: boolean) => {
      ctl.onTime(ms, playing);
      if (!playing && ms >= ctl.totalMs - 50) void session.current?.release();
    },
    onStatus: (status: PreviewStatus) => {
      ctl.onStatus(status);
      if (enabled && status.error) session.current?.interrupt(new Error(status.error));
    },
    undo: () => {
      if ((busy && phase !== 'saving') || undoing.current) return;
      undoing.current = true;
      setUndoBusy(true);
      ctl.pause();
      // Accept Undo as soon as the finger lifts, including before the take's commit completes.
      void release()
        .then(() => {
          if (session.current?.phase !== 'ready') return null;
          return undoVoiceoverTake(draftId);
        })
        .then(async (result) => {
          if (result) {
            // Removing audio does not change the video clock. Seek now even if the options
            // rebuild already reported ready before this async DB continuation runs.
            ctl.seekTo(result.playheadMs);
            const settled = await ctl.waitUntilSettled();
            console.info('[voiceover] undo position', {
              targetMs: result.playheadMs,
              actualMs: ctl.lastMs,
              settled,
            });
          }
        })
        .catch((failure: unknown) => setError(userMessage(failure, 'Try again.', 'undo voiceover')))
        .finally(() => {
          undoing.current = false;
          setUndoBusy(false);
        });
    },
    toggleMute: (track: 'source' | 'voiceover') => {
      if (busy) return;
      ctl.pause();
      void setAudioTrackMuted(
        draftId,
        track,
        track === 'source' ? !sourceMuted : !voiceoverMuted,
      ).catch((failure: unknown) => setError(userMessage(failure, 'Try again.', 'mute voiceover')));
    },
  };
}
