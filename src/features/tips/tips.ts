import type { IconName } from '@/components/icon';

/** A one-time tip, shown beside the control it's about the first time it's useful. */
export type Tip = {
  title: string;
  message: string;
  symbol: IconName;
  /**
   * `callout`: drawn by Pulse and not modal, so a tap on the control it's about still works (the
   * recorder's tips, where the first tap records). `popover`: the system popover on iOS, which
   * takes a tap outside just to close itself; fine where nothing is in a hurry. Android draws every
   * tip as a callout.
   */
  kind: 'callout' | 'popover';
};

/**
 * Every tip in the app. Each shows once, at the moment it's useful. Once shown, it's gone for good
 * when it's closed or its moment passes; before it shows, its moment passing only puts it off, and
 * only the action it teaches retires it (`useTip`). They replace the old three-page tour: the
 * welcome screen says what Pulse is, the tips teach the controls where they are.
 */
export const TIPS = {
  record: {
    title: 'Record a clip',
    message: 'Tap to start and stop, or hold and let go. Every take adds a clip.',
    symbol: 'video.fill',
    kind: 'callout',
  },
  clips: {
    title: 'Your clips',
    message: 'Tap a clip to watch and edit it. Hold one and drag to reorder, or onto the trash.',
    symbol: 'film',
    kind: 'callout',
  },
  captions: {
    title: 'Add captions',
    message: 'Captions are made on this phone. Pick a model once and they’re added for you.',
    symbol: 'captions.bubble',
    kind: 'popover',
  },
  captionEdit: {
    title: 'Fix a caption',
    message: 'Tap a caption to split, merge or delete it. Tap it again to change its words.',
    symbol: 'pencil',
    kind: 'popover',
  },
} as const satisfies Record<string, Tip>;

export type TipId = keyof typeof TIPS;
