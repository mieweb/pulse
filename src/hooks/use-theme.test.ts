import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ReactElement } from 'react';
import { Appearance, Platform } from 'react-native';

import { Colors } from '@/constants/theme';
import type { ThemePreference } from '@/db/settings';

import { ThemeProvider, useTheme, useThemePreference, type ThemeOverrides } from './use-theme';

// Exercise the real providers and public hook with controlled context and effects. This checks
// preference resolution and native/host ownership without claiming native rendering coverage.
let mockThemeState: unknown = null;
let mockStoredPreference: string | undefined;
let mockDeviceScheme: string | null | undefined = 'light';
const mockNativeAppearance = jest.fn<(value: string) => void>();
const mockReadPreference = jest.fn(() => ({
  data: mockStoredPreference === undefined ? [] : [{ value: mockStoredPreference }],
}));
const mockWritePreference = jest.fn<(preference: ThemePreference) => Promise<void>>();

jest.mock('react', () => ({
  ...jest.requireActual<typeof import('react')>('react'),
  useContext: () => mockThemeState,
  useEffect: (effect: () => void) => effect(),
  useMemo: (factory: () => unknown) => factory(),
}));
jest.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    select: (values: Record<string, unknown>) => values.ios ?? values.default,
  },
  Appearance: { setColorScheme: (value: string) => mockNativeAppearance(value) },
}));
jest.mock('drizzle-orm/expo-sqlite', () => ({
  useLiveQuery: () => mockReadPreference(),
}));
jest.mock('@/db/settings', () => ({
  themePreferenceQuery: {},
  setThemePreference: (preference: ThemePreference) => mockWritePreference(preference),
}));
jest.mock('@/hooks/use-color-scheme', () => ({ useColorScheme: () => mockDeviceScheme }));

type NativeAppearance = { setColorScheme?: (value: string) => void };
const nativeAppearance = Appearance as NativeAppearance;
const platform = Platform as { OS: string };

function renderTheme(overrides: ThemeOverrides = {}) {
  const child = ThemeProvider({ ...overrides, children: null }) as ReactElement<
    Record<string, unknown>
  >;
  const renderProvider = child.type as (
    props: Record<string, unknown>,
  ) => ReactElement<{ value: unknown }>;
  mockThemeState = renderProvider(child.props).props.value;
  return {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Controlled context harness, without a native renderer.
    ...useThemePreference(),
    // eslint-disable-next-line react-hooks/rules-of-hooks -- Controlled context harness, without a native renderer.
    palette: useTheme(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockThemeState = null;
  mockStoredPreference = undefined;
  mockDeviceScheme = 'light';
  platform.OS = 'ios';
  nativeAppearance.setColorScheme = (value) => mockNativeAppearance(value);
  mockWritePreference.mockImplementation(async (preference) => {
    mockStoredPreference = preference;
  });
});

describe('appearance preferences', () => {
  it.each(['light', 'dark'] as const)('defaults to System on a %s device', (scheme) => {
    mockDeviceScheme = scheme;

    const theme = renderTheme();

    expect(theme.preference).toBe('system');
    expect(theme.mode).toBe(scheme);
    expect(theme.palette.background).toBe(Colors[scheme].background);
    expect(mockNativeAppearance).toHaveBeenLastCalledWith('unspecified');
    expect(mockWritePreference).not.toHaveBeenCalled();
  });

  it('updates System appearance when the device changes', () => {
    mockStoredPreference = 'system';
    expect(renderTheme().mode).toBe('light');

    mockDeviceScheme = 'dark';

    const theme = renderTheme();
    expect(theme.preference).toBe('system');
    expect(theme.mode).toBe('dark');
    expect(theme.palette.background).toBe(Colors.dark.background);
    expect(mockWritePreference).not.toHaveBeenCalled();
  });

  it.each(['light', 'dark'] as const)('keeps a saved %s lock through device changes', (pin) => {
    mockStoredPreference = pin;
    mockDeviceScheme = 'light';
    expect(renderTheme().mode).toBe(pin);

    mockDeviceScheme = 'dark';

    const theme = renderTheme();
    expect(theme.preference).toBe(pin);
    expect(theme.mode).toBe(pin);
    expect(theme.palette.background).toBe(Colors[pin].background);
    expect(mockNativeAppearance).toHaveBeenLastCalledWith(pin);
  });

  it.each(['light', 'dark'] as const)('persists an explicitly selected %s lock', async (pin) => {
    mockDeviceScheme = pin === 'light' ? 'dark' : 'light';

    await renderTheme().setPreference(pin);

    expect(mockWritePreference).toHaveBeenCalledWith(pin);
    const theme = renderTheme();
    expect(theme.preference).toBe(pin);
    expect(theme.mode).toBe(pin);
    expect(mockNativeAppearance).toHaveBeenLastCalledWith(pin);
  });

  it.each(['light', 'dark'] as const)('releases a %s lock when System is selected', async (pin) => {
    mockStoredPreference = pin;
    mockDeviceScheme = pin === 'light' ? 'dark' : 'light';

    await renderTheme().setPreference('system');

    expect(mockWritePreference).toHaveBeenCalledWith('system');
    const theme = renderTheme();
    expect(theme.preference).toBe('system');
    expect(theme.mode).toBe(mockDeviceScheme);
    expect(mockNativeAppearance).toHaveBeenLastCalledWith('unspecified');
  });

  it('follows the device when a saved preference is unrecognized', () => {
    mockStoredPreference = 'sepia';
    mockDeviceScheme = 'dark';

    const theme = renderTheme();

    expect(theme.preference).toBe('system');
    expect(theme.mode).toBe('dark');
    expect(mockWritePreference).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 'unspecified'])('uses light when the device scheme is %s', (scheme) => {
    mockDeviceScheme = scheme;

    expect(renderTheme().mode).toBe('light');
  });

  it.each(['system', 'light', 'dark'] as const)(
    'leaves stored and native appearance under host ownership for explicit %s mode',
    async (mode) => {
      mockStoredPreference = 'light';
      mockDeviceScheme = 'dark';
      const theme = renderTheme({ mode });

      expect(theme.preference).toBe(mode);
      expect(theme.mode).toBe(mode === 'system' ? 'dark' : mode);
      await theme.setPreference('light');
      await theme.setPreference('dark');
      await theme.setPreference('system');

      expect(mockReadPreference).not.toHaveBeenCalled();
      expect(mockWritePreference).not.toHaveBeenCalled();
      expect(mockNativeAppearance).not.toHaveBeenCalled();
    },
  );

  it('renders web preferences when the native appearance setter is absent', async () => {
    platform.OS = 'web';
    nativeAppearance.setColorScheme = undefined;
    mockDeviceScheme = 'dark';

    expect(renderTheme().mode).toBe('dark');
    await renderTheme().setPreference('light');

    expect(renderTheme().mode).toBe('light');
    expect(mockNativeAppearance).not.toHaveBeenCalled();
  });
});
