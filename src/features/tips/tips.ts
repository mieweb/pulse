import type { IconName } from '@/components/icon';

/** A one-time tip, shown beside the control it's about the first time it's useful. */
export type Tip = {
  title: string;
  message: string;
  /** SF Symbol beside the text (iOS; Android's tooltip is text only). */
  symbol: IconName;
};

/**
 * Every tip in the app. Each shows once, at the moment it's useful, and is gone for good once
 * it's closed or its moment passes. They replace the old three-page tour: the welcome screen says
 * what Pulse is, the tips teach the controls where they are.
 */
export const TIPS = {
  record: {
    title: 'Record a clip',
    message: 'Tap to start and stop, or hold and let go. Every take adds a clip.',
    symbol: 'video.fill',
  },
  clips: {
    title: 'Your clips',
    message: 'Tap a clip to watch and edit it. Hold one and drag to reorder, or onto the trash.',
    symbol: 'film',
  },
  captions: {
    title: 'Add captions',
    message: 'Captions are made on this phone. Pick a model once and they’re added for you.',
    symbol: 'captions.bubble',
  },
  captionEdit: {
    title: 'Fix a caption',
    message: 'Tap a caption to split, merge or delete it. Tap it again to change its words.',
    symbol: 'pencil',
  },
} as const satisfies Record<string, Tip>;

export type TipId = keyof typeof TIPS;
