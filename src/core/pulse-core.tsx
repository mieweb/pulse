import { useState, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { EmbeddedRecovery } from '@/core/recovery/embedded-recovery';
import type { FatalStorage } from '@/core/recovery/types';
import { resetSession } from '@/core/session';
import { StatusBarProvider } from '@/core/status-bar/status-bar';
import { MigrationGate } from '@/db/migrate';
import { ThemeProvider, type ThemeOverrides } from '@/hooks/use-theme';

export type { FatalStorage, PulseMode } from '@/core/recovery/types';

type Common = {
  /**
   * The look the shell passes (the embed's theme bridge, F6). Without a `mode`, the Pulse app
   * uses the stored preference and the embed follows the OS.
   */
  theme?: ThemeOverrides;
  /**
   * Wraps the screens, inside the theme and the status-bar port: the shell's own providers
   * (e.g. the toast). Core can't import features, so the shell hands them in.
   */
  wrap?: ComponentType<{ children: ReactNode }>;
  /**
   * Runs once as PulseCore first renders, before anything under it does: the shell's start-up
   * (log capture, client identity). It must tolerate running again on a later mount.
   */
  onBoot?: () => void;
  children: ReactNode;
};

type Standalone = Common & {
  mode: 'standalone';
  /** The recovery screen (`StandaloneRecovery` with the shell's restore). */
  recovery: ReactElement;
  /** Housekeeping after the migrations (see `MigrationGate`). */
  afterMigrations?: () => void;
};

type Embedded = Common & {
  mode: 'embedded';
  /** The library can't be used: end the flow `failed{storage.damaged}` (B6). */
  onFatalStorage: (fatal: FatalStorage) => void;
};

export type PulseCoreProps = Standalone | Embedded;

/**
 * Everything both shells put under Pulse's screens: the gesture root, safe areas, the library
 * gate with the mode's recovery, the theme, the status-bar port and the shell's own providers.
 * The standalone shell (src/app/_layout.tsx) adds the router on top; the embed shell adds its
 * flow stack. Nothing here imports a feature, and nothing here reloads the app: in the embed a
 * reload would restart the host's runtime.
 */
export function PulseCore(props: PulseCoreProps) {
  const { mode, theme, wrap: Wrap = PassThrough, onBoot, children } = props;

  useState(() => {
    onBoot?.();
    // Each embedded presentation mounts its own PulseCore on the runtime the last one used.
    if (mode === 'embedded') resetSession();
    return null;
  });

  // The embed always passes a mode ('system' unless the host picks one): the stored preference
  // would hand a pinned mode to the OS, which changes the whole host app.
  const themeProps: ThemeOverrides | undefined =
    mode === 'embedded' ? { ...theme, mode: theme?.mode ?? 'system' } : theme;
  // A passed mode reads no stored setting, so its provider can sit outside the gate and theme the
  // gate's own screens (loading, recovery). The stored preference lives in the library: inside.
  const explicitTheme = themeProps?.mode !== undefined;

  const screens = (
    <StatusBarProvider>
      <Wrap>{children}</Wrap>
    </StatusBarProvider>
  );

  const gate = (
    <MigrationGate
      mode={mode}
      recovery={
        props.mode === 'standalone' ? (
          props.recovery
        ) : (
          <EmbeddedRecovery onFatalStorage={props.onFatalStorage} />
        )
      }
      afterMigrations={props.mode === 'standalone' ? props.afterMigrations : undefined}>
      {explicitTheme ? screens : <ThemeProvider {...themeProps}>{screens}</ThemeProvider>}
    </MigrationGate>
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {explicitTheme ? <ThemeProvider {...themeProps}>{gate}</ThemeProvider> : gate}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function PassThrough({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
