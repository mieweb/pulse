// Screen focus as a port: feature code learns whether its screen is the one on top through these
// hooks, never through a router. The standalone app feeds the port from expo-router (each route
// wraps its screen in `<ScreenFocusProvider focused={useIsFocused()}>`); a host that shows one
// screen at a time can leave the provider out, and the screen counts as focused.
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';

/** An effect run while the screen is focused; the cleanup it returns runs when focus goes. */
export type FocusEffect = () => void | (() => void);

/**
 * The rule behind `useScreenFocusEffect`, without React: the effect runs when the screen gains
 * focus and its cleanup runs when the screen loses focus or the controller is disposed (unmount).
 * One run per focus: setting the same focus again does nothing. A new effect while focused cleans
 * up the old one and runs the new one, as expo-router's `useFocusEffect` does when its callback
 * changes.
 */
export function createFocusController() {
  let focused = false;
  let effect: FocusEffect | null = null;
  let running = false;
  let cleanup: (() => void) | undefined;

  const start = () => {
    if (running || !focused || !effect) return;
    running = true;
    const destroy = effect();
    cleanup = typeof destroy === 'function' ? destroy : undefined;
  };
  const stop = () => {
    if (!running) return;
    running = false;
    const destroy = cleanup;
    cleanup = undefined;
    destroy?.();
  };

  const setFocused = (next: boolean) => {
    if (next === focused) return;
    focused = next;
    if (next) start();
    else stop();
  };
  const setEffect = (next: FocusEffect | null) => {
    if (next === effect) return;
    stop();
    effect = next;
    start();
  };

  return {
    setFocused,
    setEffect,
    /**
     * One render's focus and effect together. A blur lands before a new effect, so a callback
     * that changes as the screen loses focus never runs (as with expo-router's `useFocusEffect`).
     */
    update(nextFocused: boolean, nextEffect: FocusEffect | null) {
      if (!nextFocused) setFocused(false);
      setEffect(nextEffect);
      setFocused(nextFocused);
    },
    dispose() {
      stop();
      effect = null;
    },
  };
}

export type FocusController = ReturnType<typeof createFocusController>;

const ScreenFocusContext = createContext(true);

/** Says whether the screen below it is focused. Nested inside an unfocused screen, it is not. */
export function ScreenFocusProvider({
  focused,
  children,
}: {
  focused: boolean;
  children?: ReactNode;
}) {
  const parent = useContext(ScreenFocusContext);
  return createElement(ScreenFocusContext.Provider, { value: parent && focused }, children);
}

/** Whether this screen is the one on top (true when no provider says otherwise). */
export function useScreenFocused(): boolean {
  return useContext(ScreenFocusContext);
}

/**
 * Runs `effect` each time the screen gains focus, and its cleanup when the screen loses focus or
 * unmounts. Wrap the effect in `useCallback`: a new function while focused re-runs it.
 */
export function useScreenFocusEffect(effect: FocusEffect): void {
  const focused = useScreenFocused();
  const [controller] = useState(createFocusController);
  useEffect(() => {
    controller.update(focused, effect);
  }, [controller, focused, effect]);
  useEffect(() => () => controller.dispose(), [controller]);
}
