import { useEventListener } from 'expo';
import type { VideoPlayer } from 'expo-video';
import { useEffect, useLayoutEffect } from 'react';
import { AppState } from 'react-native';

import { useScreenFocused } from '@/core/navigation/focus';
import { useParkedPlayback } from '@/hooks/use-parked-playback';

/**
 * Export only plays by choice. A new player, a sheet, leaving the screen or leaving the app
 * pauses it; returning never resumes it. The caller remounts the preview when its URI changes,
 * so a regenerated source gets a new paused player. Native playback controls obey the same
 * restrictions as the visible Play button. Natural completion still parks at the start.
 */
export function useExportPlayback(player: VideoPlayer, blocked = false) {
  const focused = useScreenFocused();
  const { isPlaying, togglePlay } = useParkedPlayback(player);

  // expo-video releases its shared player in a passive cleanup. Pause in layout cleanup while
  // that native handle is still live, before the source is replaced or the preview unmounts.
  useLayoutEffect(() => {
    player.pause();
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') player.pause();
    });
    return () => {
      sub.remove();
      player.pause();
    };
  }, [player]);

  useEffect(() => {
    if (!focused || blocked) player.pause();
  }, [player, focused, blocked]);

  useEventListener(player, 'playingChange', ({ isPlaying: playing }) => {
    if (playing && (!focused || blocked || AppState.currentState !== 'active')) player.pause();
  });

  return {
    isPlaying,
    togglePlay: () => {
      if (!focused || blocked || AppState.currentState !== 'active') return;
      togglePlay();
    },
  };
}
