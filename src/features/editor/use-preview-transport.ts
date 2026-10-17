import type { PreviewStatus, PulsePreviewRef } from '@mieweb/pulse-editor';
import { setAudioModeAsync } from 'expo-audio';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/** What drives the preview's seeks: nothing, the strip's scrub, or a trim handle. */
export const Mode = { idle: 0, scrub: 1, trim: 2 } as const;

/** The playhead and the preview's state on the UI thread (read them in worklets, not in render). */
export type PlayheadValues = {
  /** Timeline time under the playhead, ms. */
  timeMs: SharedValue<number>;
  totalMs: SharedValue<number>;
  mode: SharedValue<number>;
  /** The preview's target while a trim handle drags (timeline ms, the untrimmed clip's). */
  trimTarget: SharedValue<number>;
  /** 1 while the preview is still on its first frame and about to seek to where the editor opened
   * (it's covered then, so frame 0 never shows). */
  covered: SharedValue<number>;
  /** True while the draft plays. */
  playing: SharedValue<boolean>;
};

/**
 * Owns the preview's handle and keeps the playhead on the UI thread:
 * - playing: `onTime` (~12 Hz) anchors the playhead and a frame callback moves it at wall-clock
 *   speed between reports (timeline time runs at 1x whatever the clip's speed);
 * - scrubbing or trimming: the frame callback hands JS at most one new target per frame, and JS
 *   keeps one seek in flight, the newest waiting (the engine chases the latest one natively too).
 * Nothing on JS runs per frame. Also sets the audio session for playback (sound with the silent
 * switch on) and pauses when the app leaves the foreground.
 */
export function usePreviewTransport() {
  const timeMs = useSharedValue(0);
  const totalMs = useSharedValue(0);
  const mode = useSharedValue<number>(Mode.idle);
  const trimTarget = useSharedValue(0);
  const playingNow = useSharedValue(false);
  const anchorMs = useSharedValue(0);
  const anchorAt = useSharedValue(0);
  const lastSent = useSharedValue(-1);
  const covered = useSharedValue(0);
  const [playing, setPlaying] = useState(false);
  const [status, setStatus] = useState<PreviewStatus | null>(null);

  // JS-side controller, created once: the worklets capture its functions (never the object,
  // which a worklet would copy and freeze).
  const [ctl] = useState(() => {
    const c = {
      ref: null as PulsePreviewRef | null,
      inflight: false,
      pending: null as number | null,
      /** Scrubbing or trimming: reported times don't move the playhead then. */
      dragging: false,
      playing: false,
      lastMs: 0,
      totalMs: 0,
      /** Seek here once the next timeline is built (a trim's new edge). */
      afterBuild: null as number | null,
      /** Where the editor opened (a clip's start): the preview's first seek goes there. */
      placeMs: null as number | null,
      /** Play once the seeks in flight have landed (play from the start, at the end). */
      playAfterSeek: false,

      setPlayingState: (p: boolean) => {
        if (p === c.playing) return;
        c.playing = p;
        playingNow.set(p);
        setPlaying(p);
      },
      seek: (ms: number) => {
        c.lastMs = ms;
        const ref = c.ref;
        if (!ref) return;
        if (c.inflight) {
          c.pending = ms;
          return;
        }
        c.inflight = true;
        ref
          .seek(ms)
          .catch(() => {})
          .finally(() => {
            c.inflight = false;
            const next = c.pending;
            c.pending = null;
            if (next != null) c.seek(next);
            else if (c.playAfterSeek) {
              c.playAfterSeek = false;
              c.ref?.play();
            }
          });
      },
      onTime: (ms: number, isPlaying: boolean) => {
        // The first frame (0) of a preview about to seek to where the editor opened isn't news.
        if (c.placeMs != null) return;
        if (!c.dragging) {
          c.lastMs = ms;
          if (isPlaying) {
            anchorMs.set(ms);
            anchorAt.set(Date.now());
          }
        }
        // Stop the frame callback's extrapolation before snapping to the paused frame.
        c.setPlayingState(isPlaying);
        if (!isPlaying && !c.dragging) timeMs.set(ms);
      },
      onStatus: (st: PreviewStatus) => {
        setStatus(st);
        if (c.placeMs != null && (st.error || !c.ref)) {
          c.placeMs = null;
          covered.set(0);
        }
        if (st.ready && !st.error && c.placeMs != null && c.ref) {
          const ms = c.placeMs;
          const ref = c.ref;
          ref
            .seek(ms)
            .catch(() => {})
            .finally(() => {
              c.placeMs = null;
              covered.set(0);
            });
        }
        if (st.ready && !st.error && c.afterBuild != null) {
          const ms = c.afterBuild;
          c.afterBuild = null;
          c.seek(ms);
        }
      },
      onReady: (ref: PulsePreviewRef) => {
        c.ref = ref;
      },
      /** The timeline's length as the editor lays it out (known before the preview is up). */
      setTotal: (ms: number) => {
        c.totalMs = ms;
        totalMs.set(ms);
      },
      play: () => {
        const ref = c.ref;
        if (!ref) return;
        // At the end, play from the start, once the preview is there (a play sent with the seek
        // would start at the end and stop).
        if (c.lastMs >= c.totalMs - 50) {
          timeMs.set(0);
          c.playAfterSeek = true;
          c.seek(0);
          return;
        }
        ref.play();
      },
      /** Pauses, and stops the playhead at once (the preview's own report follows). */
      pause: () => {
        c.playAfterSeek = false;
        c.ref?.pause();
        c.setPlayingState(false);
      },
      toggle: () => (c.playing ? c.pause() : c.play()),
      /** Open at `ms` (before the preview is up): the playhead starts there, and so does the
       * preview, without showing its first frame. */
      place: (ms: number) => {
        c.lastMs = ms;
        timeMs.set(ms);
        if (ms <= 0) return;
        c.placeMs = ms;
        covered.set(1);
      },
      /** Move the playhead and the preview to `ms` (a tap, a selection). */
      seekTo: (ms: number) => {
        const t = Math.max(0, Math.min(ms, Math.max(0, c.totalMs - 1)));
        timeMs.set(t);
        c.seek(t);
      },
      beginDrag: () => {
        c.dragging = true;
        c.playAfterSeek = false;
        if (c.playing) {
          c.ref?.pause();
          c.setPlayingState(false);
        }
        c.ref?.setScrubbing(true);
      },
      onTarget: (ms: number) => c.seek(ms),
      /** A scrub ended at `ms`: one exact seek there. */
      endScrub: (ms: number) => {
        c.ref?.setScrubbing(false);
        c.dragging = false;
        c.seek(ms);
      },
      /** A trim ended: the playhead goes to the new edge once the trimmed timeline is up. */
      endTrim: (ms: number) => {
        c.ref?.setScrubbing(false);
        c.dragging = false;
        c.lastMs = ms;
        c.afterBuild = ms;
        timeMs.set(ms);
      },
    };
    return c;
  });

  const { onTarget } = ctl;
  useFrameCallback(() => {
    const m = mode.get();
    if (m !== Mode.idle) {
      const t = m === Mode.scrub ? timeMs.get() : trimTarget.get();
      if (t !== lastSent.get()) {
        lastSent.set(t);
        scheduleOnRN(onTarget, t);
      }
    } else if (playingNow.get()) {
      timeMs.set(Math.min(totalMs.get(), anchorMs.get() + (Date.now() - anchorAt.get())));
    }
  });

  // Playback session: sound even with the silent switch on, other apps' audio paused. The
  // recorder re-applies its own (record) session when it's back on screen.
  useEffect(() => {
    void setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: false,
      interruptionMode: 'doNotMix',
    }).catch(() => {});
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') ctl.pause();
    });
    return () => {
      sub.remove();
      ctl.pause();
    };
  }, [ctl]);

  const values: PlayheadValues = {
    timeMs,
    totalMs,
    mode,
    trimTarget,
    covered,
    playing: playingNow,
  };
  return { ctl, values, playing, status };
}

export type PreviewTransport = ReturnType<typeof usePreviewTransport>;
