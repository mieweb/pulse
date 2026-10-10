import type { SymbolViewProps } from 'expo-symbols';
import type { ImageSourcePropType } from 'react-native';

/** A feature line. `icon` is the SAME SF Symbol the app uses for that action, so the
 *  tour teaches the real glyph; omit it for conceptual lines (falls back to a dot). */
export type Bullet = {
  icon?: SymbolViewProps['name'];
  /** Render the red record-button glyph (takes precedence over `icon`) for the shutter line. */
  record?: boolean;
  text: string;
};

/** A single onboarding page: a hero (logo image or SF Symbol) plus a bulleted feature list. */
export type OnboardingStep = {
  key: string;
  /** SF Symbol hero (via expo-symbols). Ignored when `image` is set. */
  symbol?: SymbolViewProps['name'];
  /** Image hero (e.g. the Pulse logo) — takes precedence over `symbol`. */
  image?: ImageSourcePropType;
  title: string;
  bullets: readonly Bullet[];
};

/**
 * The first-run tour. Three swipes that name every working feature next to the actual
 * in-app icon that triggers it, so a new user learns the glyphs as they learn the app.
 */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    key: 'welcome',
    image: require('../../../assets/images/pulse-logo-master-2048.png'),
    title: 'Welcome to Pulse',
    bullets: [
      // Not "never uploaded": a paired server is one tap away on the export screen.
      { text: 'Your recordings stay on your device unless you upload them.' },
      { text: 'No account, no sign-in — get started in seconds.' },
      { text: 'Swipe through to learn what every button does.' },
    ],
  },
  {
    key: 'record',
    symbol: 'video.fill',
    title: 'Record & arrange',
    bullets: [
      {
        record: true,
        text: 'Tap the shutter to start and stop a clip, or hold it and let go — every take adds the next clip.',
      },
      {
        icon: 'play.fill',
        text: 'Tap a clip in the segment bar to open its preview — it starts playing right away.',
      },
      {
        icon: 'scissors',
        text: 'Tap the scissors in a clip’s preview to trim, crop, rotate, mute, or change its speed.',
      },
      // No icon: nothing on screen draws one for reordering (the clip itself is what you hold).
      { text: 'Press and hold a clip, then drag it onto another to swap their places.' },
      {
        icon: 'trash.fill',
        text: 'Drag a clip onto the trash to delete it — Undo brings it back.',
      },
      {
        icon: 'arrow.triangle.2.circlepath.camera',
        text: 'Flip cameras, switch lenses, pinch to zoom, turn on the flash, steady your shot with stabilization, or mute audio.',
      },
    ],
  },
  {
    key: 'finish',
    symbol: 'captions.bubble.fill',
    title: 'Caption, polish & share',
    bullets: [
      { icon: 'arrow.right', text: 'Tap Next to merge all your clips into one seamless video.' },
      // Captions are off until a model is chosen: "Add captions" (this glyph) on the export
      // screen opens On-device AI, as the caption editor's wand does later.
      {
        icon: 'captions.bubble',
        text: 'Tap Add captions to choose a model, from Base to multilingual Large Turbo — captions are made on your device.',
      },
      {
        icon: 'arrow.triangle.merge',
        text: 'In the caption editor, fix any caption’s words, or split, merge, or delete captions.',
      },
      {
        icon: 'arrow.uturn.backward',
        text: 'Undo and redo as you go, or reset to the automatic captions.',
      },
      {
        icon: 'square.and.arrow.up',
        text: 'Share via the system sheet, save to Photos or Files, or upload to a server you’ve paired.',
      },
      {
        icon: 'square.and.arrow.down',
        text: 'Rename, delete, and reopen drafts at home, or move them between devices as .pulse files.',
      },
    ],
  },
];
