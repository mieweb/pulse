import { reloadAppAsync } from 'expo';
import Constants from 'expo-constants';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { PulseCore } from '@/core/pulse-core';
import { StandaloneRecovery } from '@/core/recovery/standalone-recovery';
import { type StatusBarStyle, useStatusBarTop } from '@/core/status-bar/status-bar';
import { expoDb } from '@/db/client';
import { type BuildConfig, readBuildInfo } from '@/features/about/build-info';
import {
  removeLeftoverRestores,
  restoreLibraryBackup,
} from '@/features/draft-transfer/library-backup';
import { installLogCapture } from '@/features/logs/logger';
import { ScreenCaptureLifecycle } from '@/features/screen-capture/screen-capture';
import { ToastProvider, useToast } from '@/features/toast/toast-provider';
import { setClientIdentity } from '@/features/upload/core/client-identity';
import { startUploads } from '@/features/upload/core/start-uploads';
import { UploadStrategyContext } from '@/features/upload/core/target-provider';
import { destinationsSheetOptions } from '@/features/upload/pairing/destinations-sheet';
import { poolProvider } from '@/features/upload/pairing/pool-provider';
import { UploadDeepLinkProvider } from '@/features/upload/pairing/upload-deep-link-provider';
import { useThemeMode } from '@/hooks/use-theme';
import { copyToClipboard } from '@/utils/clipboard';
import { tallSheetOptions } from '@/utils/sheet-fit';

/** The Pulse app's start-up, run by PulseCore before anything renders. */
function bootStandalone() {
  // First, so the debug log (About → Share logs) sees the whole session.
  installLogCapture();
  // Every request to a server says which build this is (`Pulse-Client`) and every upload records
  // it (`appVersion`) — PROTOCOL.md §7.2.
  const build = readBuildInfo(Constants.expoConfig as BuildConfig | null, Platform.OS);
  setClientIdentity({ version: build.version, build: build.buildNumber, platform: Platform.OS });
}

/**
 * The recovery screen's restore: stage the backup (there's no sound library to snapshot first),
 * then restart so the next launch swaps it in. Only the Pulse app may restart itself: in the embed
 * a reload would restart the host's runtime.
 */
async function restoreFromRecovery(fileUri: string): Promise<void> {
  await restoreLibraryBackup(expoDb, fileUri, Date.now(), { snapshotCurrent: false });
  await reloadAppAsync('Restoring a library backup');
}

export default function RootLayout() {
  return (
    // The stored theme live-queries the settings table, so PulseCore mounts it inside the
    // library gate — on a fresh install the table doesn't exist until migrations run. The gate's
    // own loading/error UI follows the OS scheme (see use-theme.tsx).
    <PulseCore
      mode="standalone"
      onBoot={bootStandalone}
      wrap={ToastProvider}
      recovery={<StandaloneRecovery restore={restoreFromRecovery} />}
      // Unzipped restores and imports a crash left behind: nothing of this version is writing
      // them yet.
      afterMigrations={removeLeftoverRestores}>
      {/* The Pulse app uploads to destinations paired from links. */}
      <UploadStrategyContext.Provider value={poolProvider}>
        <ThemedNavigation />
      </UploadStrategyContext.Provider>
    </PulseCore>
  );
}

/** Navigation tree, themed from the RESOLVED scheme (manual override, else OS) so the router
 * theme and status bar can't drift from the app's own colors when the user flips the switch. */
function ThemedNavigation() {
  const isDark = useThemeMode() === 'dark';
  // The full-screen screens (recorder, editor, export, welcome) appear and go at once, like a
  // camera app's: no slide up from the bottom. The sheets keep the system's own presentation.
  const fullScreen = { presentation: 'fullScreenModal', animation: 'none' } as const;

  return (
    <ThemeProvider value={isDark ? DarkTheme : DefaultTheme}>
      {/* First, so the upload manager has its toast before any link or screen starts an upload. */}
      <UploadsStarter />
      <ScreenCaptureLifecycle />
      <UploadDeepLinkProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="recorder" options={fullScreen} />
          <Stack.Screen name="export" options={fullScreen} />
          <Stack.Screen name="editor" options={{ ...fullScreen, gestureEnabled: false }} />
          <Stack.Screen
            name="about"
            options={() => ({
              presentation: 'formSheet',
              sheetGrabberVisible: true,
              // Sized to its content, or full height and scrolling at large text sizes.
              ...tallSheetOptions(),
            })}
          />
          <Stack.Screen
            name="on-device-ai"
            options={() => ({
              presentation: 'formSheet',
              sheetGrabberVisible: true,
              // Sized to its content, or full height and scrolling at large text sizes.
              ...tallSheetOptions(),
            })}
          />
          <Stack.Screen
            name="destinations"
            options={({ route }) => ({
              presentation: 'formSheet',
              sheetGrabberVisible: true,
              // The home pill passes `?count`; a link without it gives NaN, which sizes the
              // sheet for a long list (`destinationsSheetOptions`).
              ...destinationsSheetOptions(
                Number((route.params as { count?: string } | undefined)?.count),
              ),
            })}
          />
          <Stack.Screen
            name="pair"
            options={{
              presentation: 'formSheet',
              ...tallSheetOptions(),
              sheetGrabberVisible: true,
            }}
          />
          <Stack.Screen name="onboarding" options={{ ...fullScreen, gestureEnabled: false }} />
        </Stack>
      </UploadDeepLinkProvider>
      <StandaloneStatusBar fallback={isDark ? 'light' : 'dark'} />
    </ThemeProvider>
  );
}

/**
 * Runs the upload manager for the app's lifetime, with the app's toast and clipboard. A leaf of its
 * own: the toast context changes with every toast, and the navigation tree shouldn't re-render.
 */
function UploadsStarter() {
  const { showToast } = useToast();
  useEffect(() => startUploads({ showToast, copyLink: copyToClipboard }), [showToast]);
  return null;
}

/** The standalone implementation of the status-bar port: the style a screen asks for (the newest
 * request wins, e.g. light over the recorder's camera), else the theme's. */
function StandaloneStatusBar({ fallback }: { fallback: StatusBarStyle }) {
  return <StatusBar style={useStatusBarTop() ?? fallback} />;
}
