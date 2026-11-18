// The status bar as a port: feature code asks for a style with `useStatusBarStyle`, and whatever
// renders the real status bar reads the top of the stack with `useStatusBarTop`. The standalone app
// renders expo-status-bar from it (app/_layout.tsx); without a provider, a request does nothing and
// the host keeps its own status bar.
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';

import { createStatusBarStack, type StatusBarStack, type StatusBarStyle } from './status-bar-stack';

export type { StatusBarStyle } from './status-bar-stack';

const StatusBarContext = createContext<StatusBarStack | null>(null);

/** Holds the stack for the screens below it. */
export function StatusBarProvider({ children }: { children?: ReactNode }) {
  const [stack] = useState(createStatusBarStack);
  return <StatusBarContext.Provider value={stack}>{children}</StatusBarContext.Provider>;
}

/**
 * Asks for `style` while mounted; the newest request wins. Pass null to ask for nothing (for
 * example while the screen is covered), which hands the bar back to the request before it.
 */
export function useStatusBarStyle(style: StatusBarStyle | null): void {
  const stack = useContext(StatusBarContext);
  useEffect(() => {
    if (!stack || !style) return;
    const entry = stack.push(style);
    return () => stack.pop(entry);
  }, [stack, style]);
}

const noStack = () => () => {};
const noStyle = () => null;

/** The style on top of the stack, or null when nothing is asked for (or there is no provider). */
export function useStatusBarTop(): StatusBarStyle | null {
  const stack = useContext(StatusBarContext);
  return useSyncExternalStore(stack?.subscribe ?? noStack, stack?.top ?? noStyle);
}
