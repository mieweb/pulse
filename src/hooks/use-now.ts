import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * Wall-clock `Date.now()` as reactive state, refreshed every `intervalMs`. Unlike `useTick`
 * (which only forces a re-render), this returns the timestamp itself as a *stable* value for the
 * render — so callers can derive time-based UI (expiry countdowns) and use it in memo/effect
 * dependencies without calling the impure `Date.now()` in render, and without recomputing on
 * every unrelated render. The time moves forward on each interval tick, and at once when the app
 * comes back to the foreground (timers don't run in the background, so it would otherwise read up
 * to `intervalMs` stale, or hours if the app sat suspended).
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, intervalMs);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') tick();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [intervalMs]);
  return now;
}
