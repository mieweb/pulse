import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Appearance } from 'react-native';

import { Colors, SystemColors, type ThemeColor } from '@/constants/theme';
import { setThemePreference, themePreferenceQuery, type ThemePreference } from '@/db/settings';
import { useColorScheme } from '@/hooks/use-color-scheme';

type ResolvedScheme = 'light' | 'dark';

/** One mode's colours: the theme tokens, plus the colour of destructive actions. */
export type Palette = { readonly [K in ThemeColor]: string } & { readonly destructive: string };

/**
 * What a shell may pass the provider instead of, or on top of, the stored preference. With a
 * `mode` the provider never reads or writes the stored preference and never touches the OS-wide
 * appearance: the host owns both (the embed's theme bridge, F6). Colours are '#rrggbb' and apply
 * to both modes; `buttonRadius` is in points.
 */
export type ThemeOverrides = {
  mode?: ThemePreference;
  accent?: string;
  destructive?: string;
  buttonRadius?: number;
};

type ThemeState = {
  resolved: ResolvedScheme;
  preference: ThemePreference;
  /** True when the shell passed the mode: the appearance control then changes nothing. */
  explicit: boolean;
  palettes: Record<ResolvedScheme, Palette>;
  buttonRadius: number | undefined;
};

const DEFAULT_PALETTES: Record<ResolvedScheme, Palette> = {
  light: { ...Colors.light, destructive: SystemColors.red.light },
  dark: { ...Colors.dark, destructive: SystemColors.red.dark },
};

const ThemeStateContext = createContext<ThemeState | null>(null);

/**
 * Resolves the effective light/dark mode once and exposes it via context together with the
 * preference ('system' follows the OS live). The mode is the shell's `mode` when it passes one
 * (the embed), else the user's stored preference (persisted via the home screen's appearance
 * control). `useColorScheme()` can return `null`/`undefined` (scheme not yet known) as well as the
 * literal `"unspecified"` (Android's Appearance API when the OS reports no preference) — none of
 * those are keys in `Colors`, so all three fall back to light.
 *
 * Without a `mode`, mount once near the app root, INSIDE `MigrationGate`: the provider then
 * live-queries the `settings` table, which doesn't exist until schema migrations have run on a
 * fresh install. With a `mode` it reads nothing, so it may sit outside the gate and theme the
 * gate's own screens too.
 * `useTheme()`/`useThemeToggle()` are called from very frequently-rendered leaf components
 * (`ThemedText`, `ThemedView`, cue rows, …), so resolving the scheme here — a single
 * `useLiveQuery` subscription — avoids each of those instances opening its own Drizzle
 * live-query subscription.
 */
export function ThemeProvider({
  children,
  ...overrides
}: ThemeOverrides & { children: ReactNode }) {
  // A shell either always passes a mode or never does, so this never swaps one provider for the
  // other (which would remount the whole tree).
  return overrides.mode === undefined ? (
    <StoredThemeProvider {...overrides}>{children}</StoredThemeProvider>
  ) : (
    <ExplicitThemeProvider {...overrides} mode={overrides.mode}>
      {children}
    </ExplicitThemeProvider>
  );
}

type ProviderProps = Omit<ThemeOverrides, 'mode'> & { children: ReactNode };

/** The standalone app: the stored preference, handed to the OS too. */
function StoredThemeProvider({ children, accent, destructive, buttonRadius }: ProviderProps) {
  const osScheme = useOsScheme();

  const { data } = useLiveQuery(themePreferenceQuery, []);
  const pref = data[0]?.value;
  // Anything that isn't an explicit pin — no row (fresh install / pre-'system' installs) or
  // a stored 'system' — follows the OS, so 'system' is the default without a migration.
  const preference: ThemePreference = pref === 'light' || pref === 'dark' ? pref : 'system';
  const resolved: ResolvedScheme = preference === 'system' ? osScheme : preference;
  const value = useThemeState(resolved, preference, false, accent, destructive, buttonRadius);

  // Hand a pinned mode to the OS too, so what it draws for the app follows it: the glass behind
  // a form sheet, alerts, menus, the system paste button. Without this they kept the phone's own
  // mode under a pinned one (light glass under dark text). 'unspecified' goes back to the OS.
  useEffect(() => {
    Appearance.setColorScheme(preference === 'system' ? 'unspecified' : preference);
  }, [preference]);

  return <ThemeStateContext.Provider value={value}>{children}</ThemeStateContext.Provider>;
}

/**
 * The shell's mode (the embed). `Appearance.setColorScheme` would change the whole host app, so
 * it's never called here: the host's container owns the appearance of Pulse's screens.
 */
function ExplicitThemeProvider({
  children,
  mode,
  accent,
  destructive,
  buttonRadius,
}: ProviderProps & { mode: ThemePreference }) {
  const osScheme = useOsScheme();
  const resolved: ResolvedScheme = mode === 'system' ? osScheme : mode;
  const value = useThemeState(resolved, mode, true, accent, destructive, buttonRadius);
  return <ThemeStateContext.Provider value={value}>{children}</ThemeStateContext.Provider>;
}

function useThemeState(
  resolved: ResolvedScheme,
  preference: ThemePreference,
  explicit: boolean,
  accent: string | undefined,
  destructive: string | undefined,
  buttonRadius: number | undefined,
): ThemeState {
  const palettes = useMemo(
    () =>
      accent === undefined && destructive === undefined
        ? DEFAULT_PALETTES
        : {
            light: withOverrides(DEFAULT_PALETTES.light, accent, destructive),
            dark: withOverrides(DEFAULT_PALETTES.dark, accent, destructive),
          },
    [accent, destructive],
  );
  // Memoized on scalars: context uses reference equality, and useTheme() consumers are hot leaf
  // components — a fresh object per render (e.g. a live-query re-emit of the same value) would
  // re-render them all for nothing.
  return useMemo(
    () => ({ resolved, preference, explicit, palettes, buttonRadius }),
    [resolved, preference, explicit, palettes, buttonRadius],
  );
}

function withOverrides(
  base: Palette,
  accent: string | undefined,
  destructive: string | undefined,
): Palette {
  return {
    ...base,
    ...(accent !== undefined ? { accent } : null),
    ...(destructive !== undefined ? { destructive } : null),
  };
}

function useOsScheme(): ResolvedScheme {
  const scheme = useColorScheme();
  return scheme === 'light' || scheme === 'dark' ? scheme : 'light';
}

/**
 * Outside the provider — i.e. `MigrationGate`'s pre-migration loading/error UI in the standalone
 * app, where the `settings` table may not exist yet so the stored preference is unreadable —
 * themed components deliberately follow the OS scheme instead.
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

export function useTheme(): Palette {
  const palettes = useContext(ThemeStateContext)?.palettes ?? DEFAULT_PALETTES;
  return palettes[useResolvedScheme()];
}

/** The button corner radius the shell passed (points), or undefined for each button's own. */
export function useButtonRadius(): number | undefined {
  return useContext(ThemeStateContext)?.buttonRadius;
}

/** The three-state appearance control on the home header. `preference` is the stored choice
 * ('system' follows the OS live); `mode` is what's actually rendering. Cycling order:
 * System → Light → Dark → System. Under a mode the shell passed, `toggle` changes nothing. */
export function useThemeToggle() {
  const state = useContext(ThemeStateContext);
  const preference = state?.preference ?? 'system';
  const explicit = state?.explicit ?? false;
  const mode = useResolvedScheme();
  const toggle = () => {
    if (explicit) return;
    void setThemePreference(
      preference === 'system' ? 'light' : preference === 'light' ? 'dark' : 'system',
    );
  };
  return { preference, mode, toggle };
}
