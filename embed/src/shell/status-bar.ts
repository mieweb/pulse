import { useEffect } from 'react';

import { useStatusBarTop } from '@/core/status-bar/status-bar';
import { useThemeMode } from '@/hooks/use-theme';

import type { UiSender } from './messaging';

/**
 * The embed's implementation of the core status-bar port (AD22). Inside a host only PulseKit's
 * container view controller can change the status bar (it works under the host's
 * `UIViewControllerBasedStatusBarAppearance=YES`), so the style the screens ask for goes to it as
 * `pulse.ui` rather than through a status-bar package. It sends the style on top of the port's
 * stack, else the theme's (light text in dark mode), as the standalone app's
 * `StandaloneStatusBar` does. Renders nothing.
 */
export function EmbedStatusBar({ ui }: { ui: UiSender }): null {
  const top = useStatusBarTop();
  const fallback = useThemeMode() === 'dark' ? 'light' : 'dark';
  const style = top ?? fallback;
  useEffect(() => ui({ statusBar: style, statusBarHidden: false }), [ui, style]);
  return null;
}
