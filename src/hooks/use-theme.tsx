import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { createContext, useContext, type ReactNode } from 'react';

import { Colors } from '@/constants/theme';
import { setThemePreference, themePreferenceQuery, type ThemePreference } from '@/db/settings';
import { useColorScheme } from '@/hooks/use-color-scheme';

type ResolvedScheme = 'light' | 'dark';

type ThemeState = { resolved: ResolvedScheme; preference: ThemePreference };

const ThemeStateContext = createContext<ThemeState | null>(null);

/**
 * Resolves the effective light/dark mode once — the user's stored preference (persisted via
 * the home screen's appearance control) when it pins a mode, else the OS color scheme — and
 * exposes it via context together with the raw preference ('system' follows the OS live).
 * `useColorScheme()` can return `null`/`undefined` (scheme not yet known) as well as the
 * literal `"unspecified"` (Android's Appearance API when the OS reports no preference) —
 * none of those are keys in `Colors`, so all three fall back to light.
 *
 * Mount once near the app root, INSIDE `MigrationGate`: the provider live-queries the
 * `settings` table, which doesn't exist until schema migrations have run on a fresh install.
 * `useTheme()`/`useThemeToggle()` are called from very frequently-rendered leaf components
 * (`ThemedText`, `ThemedView`, cue rows, …), so resolving the scheme here — a single
 * `useLiveQuery` subscription — avoids each of those instances opening its own Drizzle
 * live-query subscription.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const osScheme = useOsScheme();

  const { data } = useLiveQuery(themePreferenceQuery, []);
  const pref = data[0]?.value;
  // Anything that isn't an explicit pin — no row (fresh install / pre-'system' installs) or
  // a stored 'system' — follows the OS, so 'system' is the default without a migration.
  const preference: ThemePreference = pref === 'light' || pref === 'dark' ? pref : 'system';
  const resolved: ResolvedScheme = preference === 'system' ? osScheme : preference;

  return (
    <ThemeStateContext.Provider value={{ resolved, preference }}>
      {children}
    </ThemeStateContext.Provider>
  );
}

function useOsScheme(): ResolvedScheme {
  const scheme = useColorScheme();
  return scheme === 'light' || scheme === 'dark' ? scheme : 'light';
}

/**
 * Outside the provider — i.e. `MigrationGate`'s pre-migration loading/error UI, where the
 * `settings` table may not exist yet so the stored preference is unreadable — themed
 * components deliberately follow the OS scheme instead.
 */
function useResolvedScheme(): ResolvedScheme {
  const fromContext = useContext(ThemeStateContext);
  const osScheme = useOsScheme();
  return fromContext?.resolved ?? osScheme;
}

/** The resolved light/dark mode (manual override, else OS scheme). Drives the navigation
 * theme and status bar in the root layout, so they can't drift from the app's own colors. */
export function useThemeMode(): ResolvedScheme {
  return useResolvedScheme();
}

export function useTheme() {
  return Colors[useResolvedScheme()];
}

/** The three-state appearance control on the home header. `preference` is the stored choice
 * ('system' follows the OS live); `mode` is what's actually rendering. Cycling order:
 * System → Light → Dark → System. */
export function useThemeToggle() {
  const preference = useContext(ThemeStateContext)?.preference ?? 'system';
  const mode = useResolvedScheme();
  const toggle = () =>
    void setThemePreference(
      preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system',
    );
  return { preference, mode, toggle };
}
