import type { ReactNode } from 'react';

import type { MenuAction } from '@/components/action-menu';

/**
 * The shared "+" menu (`PlusMenu`, plus-menu.tsx / plus-menu.ios.tsx): a list of ways to add clips
 * behind one round button. The recorder's "+" (`AddMenu`) offers Import video and Record screen;
 * the editor's adds at the playhead's clip boundary (editor-add-menu.tsx). A new way to add (an
 * image or screenshot, clips from another Pulse) is one more `MenuAction` in a list.
 */
export type PlusMenuProps = {
  /** The items, in order. One: the "+" is that item, no menu. */
  actions: MenuAction[];
  /** The menu can open now (not while the button is disabled or busy). */
  enabled: boolean;
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
  onRecordScreen: () => void;
  /**
   * False without screen recording (the embed) or while a screen take runs: "+" is then the plain
   * import, no one-item menu.
   */
  screenAvailable: boolean;
  disabled: boolean;
  busy: boolean;
  progress: number | null;
};

/** The "+ menu" items both screens share: Import video, and Record screen where it's offered. */
export const importVideoAction = (onPress: () => void): MenuAction => ({
  key: 'import',
  label: 'Import video',
  icon: 'photo.on.rectangle',
  onPress,
});
export const recordScreenAction = (onPress: () => void): MenuAction => ({
  key: 'screen',
  label: 'Record screen',
  icon: 'record.circle',
  onPress,
});

/** The recorder "+" menu's items. */
export function addMenuActions({
  onImport,
  onRecordScreen,
}: Pick<AddMenuProps, 'onImport' | 'onRecordScreen'>): MenuAction[] {
  return [importVideoAction(onImport), recordScreenAction(onRecordScreen)];
}
