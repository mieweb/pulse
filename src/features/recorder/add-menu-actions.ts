import type { ReactNode } from 'react';

import type { MenuAction } from '@/components/action-menu';

/**
 * The shared "+" menu (`PlusMenu`, plus-menu.tsx / plus-menu.ios.tsx): a list of ways to add clips
 * behind one round button. The recorder's "+" (`AddMenu`) offers Import video, Import image or
 * screenshot and Record screen; the editor's adds at the playhead's clip boundary
 * (editor-add-menu.tsx). A new way to add (clips from another Pulse) is one more `MenuAction` in a
 * list.
 */
export type PlusMenuProps = {
  /** The items, in order. One: the "+" is that item, no menu. */
  actions: MenuAction[];
  /** The menu can open now (not while the button is disabled or busy). */
  enabled: boolean;
  /** The "+" was pressed, before its menu opens (the editor pauses, so the playhead stays put). */
  onOpen?: () => void;
  /** The round button the menu opens from, tapped with `onPress`. */
  renderButton: (onPress: () => void) => ReactNode;
  /** The menu's screen-reader label and hint (iOS: the button under it is hidden then). */
  label: string;
  hint?: string;
  /** The button's diameter (default 44). */
  size?: number;
};

export type AddMenuProps = {
  onImport: () => void;
  onImportImages: () => void;
  onRecordScreen: () => void;
  /** False without screen recording (the embed) or while a screen take runs: no Record screen. */
  screenAvailable: boolean;
  /** "From another Pulse": copy clips of another draft here. Absent: no other draft has clips. */
  onFromAnotherPulse?: () => void;
  disabled: boolean;
  busy: boolean;
  progress: number | null;
  /** What the busy "+" is doing, for screen readers ("Adding 2 of 5"). */
  progressText?: string;
  /** Shown beside the busy "+" during a batch of images ("2/5"). */
  progressCount?: string;
};

/**
 * The "+ menu" items both screens share: Record screen where it's offered, Import video, Import
 * image or screenshot, and From another Pulse while another draft has clips.
 */
export const importVideoAction = (onPress: () => void): MenuAction => ({
  key: 'import',
  label: 'Video',
  icon: 'video.fill',
  onPress,
});
export const importImagesAction = (onPress: () => void): MenuAction => ({
  key: 'images',
  label: 'Photo',
  icon: 'photo.on.rectangle',
  onPress,
});
export const recordScreenAction = (onPress: () => void): MenuAction => ({
  key: 'screen',
  label: 'Screen',
  icon: 'record.circle',
  onPress,
});

/** "From another Pulse": copy clips of another draft here, with their edits and captions. */
export const fromAnotherPulseAction = (onPress: () => void): MenuAction => ({
  key: 'another',
  label: 'Other Pulse',
  icon: 'rectangle.stack',
  onPress,
});

/** The recorder "+" menu's items. */
export function addMenuActions({
  onImport,
  onImportImages,
  onRecordScreen,
  screenAvailable,
  onFromAnotherPulse,
}: Pick<
  AddMenuProps,
  'onImport' | 'onImportImages' | 'onRecordScreen' | 'screenAvailable' | 'onFromAnotherPulse'
>): MenuAction[] {
  return [
    ...(screenAvailable ? [recordScreenAction(onRecordScreen)] : []),
    importVideoAction(onImport),
    importImagesAction(onImportImages),
    ...(onFromAnotherPulse ? [fromAnotherPulseAction(onFromAnotherPulse)] : []),
  ];
}
