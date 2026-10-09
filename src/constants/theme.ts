import { Platform } from 'react-native';

/**
 * iOS / iPadOS 27 system red — record button, primary actions, highlights.
 * Base (light) value; the theme `accent` token below is mode-aware.
 */
export const Accent = '#FF383C';

/**
 * iOS / iPadOS 27 system color ramp (Apple Design Resources, Beta).
 * Exact values pulled from the official UI Kit variable collection.
 * Use these for any new design work that should feel native on iOS 27.
 */
export const SystemColors = {
  // System accent colors — light / dark
  red: { light: '#FF383C', dark: '#FF4245' },
  orange: { light: '#FF8D28', dark: '#FF9230' },
  yellow: { light: '#FFCC00', dark: '#FFD600' },
  green: { light: '#34C759', dark: '#30D158' },
  mint: { light: '#00C8B3', dark: '#00DAC3' },
  teal: { light: '#00C3D0', dark: '#00D2E0' },
  cyan: { light: '#00C0E8', dark: '#3CD3FE' },
  blue: { light: '#0088FF', dark: '#0091FF' },
  indigo: { light: '#6155F5', dark: '#6D7CFF' },
  purple: { light: '#CB30E0', dark: '#DB34F2' },
  pink: { light: '#FF2D55', dark: '#FF375F' },
  brown: { light: '#AC7F5E', dark: '#B78A66' },
  // System grays 1–6 — light / dark
  gray: { light: '#8E8E93', dark: '#8E8E93' },
  gray2: { light: '#AEAEB2', dark: '#636366' },
  gray3: { light: '#C7C7CC', dark: '#48484A' },
  gray4: { light: '#D1D1D6', dark: '#3A3A3C' },
  gray5: { light: '#E5E5EA', dark: '#2C2C2E' },
  gray6: { light: '#F2F2F7', dark: '#1C1C1E' },
} as const;

/**
 * Semantic theme tokens mapped to iOS / iPadOS 27 system colors.
 * The comment after each value names the Apple semantic role it mirrors.
 */
export const Colors = {
  light: {
    text: '#000000', // Label / Primary
    background: '#ffffff', // Background / Primary (systemBackground)
    backgroundElement: '#F2F2F7', // Background / Secondary (secondarySystemBackground)
    backgroundSelected: '#E5E5EA', // System Gray 5
    textSecondary: 'rgba(60,60,67,0.6)', // Label / Secondary
    border: '#C6C6C8', // Separator / Opaque (opaqueSeparator)
    accent: SystemColors.red.light, // #FF383C
    warning: SystemColors.orange.light, // #FF8D28 — soft/at-risk states
    onAccent: '#ffffff',
    // Grouped screens (home, export, captions) and their cards, iOS's grouped style: white cards
    // with CardShadow on a light grey, the same as on the sheets (where white reads as a raised
    // card both on the grey glass and on the solid white it turns into at full height).
    groupedBackground: '#F2F2F7', // systemGroupedBackground
    card: '#ffffff',
    // A control sitting on a card (a card's link pill): white with its own shadow in light.
    cardRaised: '#ffffff',
    cardRaisedPressed: '#E5E5EA', // System Gray 5
  },
  dark: {
    text: '#ffffff', // Label / Primary
    background: '#000000', // Background / Primary (systemBackground)
    // Element fills use Apple's ELEVATED dark palette (one gray step up): the base
    // secondarySystemBackground (#1C1C1E) is nearly invisible on the pure-black primary
    // background, even with a hairline ring.
    backgroundElement: '#2C2C2E', // Background / Secondary, elevated (System Gray 5)
    backgroundSelected: '#3A3A3C', // System Gray 4
    textSecondary: 'rgba(235,235,245,0.7)', // Label / Secondary
    border: '#48484A', // System Gray 3 — reads as an outline on the elevated fills
    accent: SystemColors.red.dark, // #FF4245
    warning: SystemColors.orange.dark, // #FF9230 — soft/at-risk states
    onAccent: '#ffffff',
    // Dark has no shadows to lean on: the cards are the elevated fill on black, and a control on
    // a card steps up one more gray.
    groupedBackground: '#000000',
    card: '#2C2C2E',
    cardRaised: '#3A3A3C',
    cardRaisedPressed: '#48484A', // System Gray 3
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/**
 * Translucent fill for round control chrome on THEMED backgrounds (not over live video —
 * that's GlassPill's job). A dark scrim disappears on dark mode's black background, so each
 * mode gets its own fill; the dark fill adds a hairline edge for a crisp outline. Glyphs on
 * top stay white in both modes.
 */
export const ControlScrim = {
  light: { backgroundColor: 'rgba(0,0,0,0.35)', borderColor: 'transparent' },
  dark: { backgroundColor: 'rgba(255,255,255,0.15)', borderColor: 'rgba(255,255,255,0.25)' },
} as const;

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

/**
 * The lift for cards, rows on sheets, and controls that sit on them: a soft shadow, not a border
 * (borders stay for selection rings, and for chrome over video, where a shadow vanishes).
 */
export const CardShadow = {
  shadowColor: '#000',
  shadowOpacity: 0.08,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 2 },
  elevation: 2,
} as const;

/**
 * The lift for things that float above the screen's content (the home + button, the destinations
 * pill, the toast, the Android ⋯ menu): one step above `CardShadow`. In dark mode, where a shadow
 * doesn't show on black, a floating surface also uses `cardRaised` so it separates from the cards.
 */
export const FloatShadow = {
  shadowColor: '#000',
  shadowOpacity: 0.18,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 6,
} as const;

/** Corner radii: rows and small chips, buttons, cards and sheets' rows. */
export const Radius = {
  row: 12,
  button: 14,
  card: 18,
} as const;

/** The height of a primary or paired button row. */
export const ButtonHeight = 52;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;
