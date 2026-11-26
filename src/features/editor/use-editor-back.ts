import { useCallback } from 'react';
import { BackHandler } from 'react-native';
import { useScreenFocusEffect } from '@/core/navigation/focus';

/** Busy commits own Back even after a toolbar interaction returns to the main mode. */
export function useEditorBack({
  busy,
  cropping,
  typing,
  tools,
  mode,
  setCropping,
  setTyping,
  setTools,
  setMode,
}: {
  busy: boolean;
  cropping: boolean;
  typing: boolean;
  tools: 'clip' | 'speed';
  mode: 'main' | 'edit' | 'captions' | 'voiceover';
  setCropping: (value: null) => void;
  setTyping: (value: null) => void;
  setTools: (value: 'clip') => void;
  setMode: (value: 'main') => void;
}) {
  useScreenFocusEffect(
    useCallback(() => {
      if (!busy && !cropping && !typing && tools === 'clip' && mode === 'main') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (busy) return true;
        if (cropping) setCropping(null);
        else if (typing) setTyping(null);
        else if (tools !== 'clip') setTools('clip');
        else setMode('main');
        return true;
      });
      return () => sub.remove();
    }, [busy, cropping, typing, tools, mode, setCropping, setTyping, setTools, setMode]),
  );
}
