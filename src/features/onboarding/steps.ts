import type { IconName } from '@/components/icon';

/** One row of the welcome screen: what Pulse does, in a glyph, a few words and a line. */
export type WelcomeFeature = {
  icon: IconName;
  title: string;
  text: string;
};

/**
 * The welcome screen's rows, in the shape of Apple's own "Welcome to …" screens: what the app is
 * for, not how each button works. The controls are taught by one-time tips beside them, the
 * first time each is useful (features/tips).
 */
export const WELCOME_FEATURES: readonly WelcomeFeature[] = [
  {
    icon: 'video.fill',
    title: 'Record in clips',
    text: 'Tap or hold the shutter. Every take adds a clip you can trim, reorder or remove.',
  },
  {
    icon: 'captions.bubble.fill',
    title: 'Captions on your phone',
    text: 'Pulse writes captions on this device, so your video doesn’t go anywhere to get them.',
  },
  {
    icon: 'square.and.arrow.up',
    title: 'Share it your way',
    text: 'Save to Photos or Files, share it anywhere, or upload to a server you’ve paired.',
  },
];
