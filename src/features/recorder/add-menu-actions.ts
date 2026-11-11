import type { MenuAction } from '@/components/action-menu';

export type AddMenuProps = {
  onImport: () => void;
  onRecordScreen: () => void;
  /** False while a screen take runs: "+" is then the plain import, no one-item menu. */
  screenAvailable: boolean;
  disabled: boolean;
  busy: boolean;
  progress: number | null;
};

/** The recorder "+" menu's items, shared by the iOS system menu and the Android popover. */
export function addMenuActions({
  onImport,
  onRecordScreen,
}: Pick<AddMenuProps, 'onImport' | 'onRecordScreen'>): MenuAction[] {
  return [
    { key: 'import', label: 'Import video', icon: 'photo.on.rectangle', onPress: onImport },
    { key: 'screen', label: 'Record screen', icon: 'record.circle', onPress: onRecordScreen },
  ];
}
