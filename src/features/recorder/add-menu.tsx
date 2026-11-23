import { type AddMenuProps, addMenuActions } from './add-menu-actions';
import { ImportButton } from './import-button';
import { PlusMenu } from './plus-menu';

/**
 * The recorder's "+": Import video or Record screen (the shared `PlusMenu`: the iOS system menu,
 * an Android popover). Without screen recording a tap imports, as before.
 */
export function AddMenu({
  onImport,
  onRecordScreen,
  screenAvailable,
  disabled,
  busy,
  progress,
}: AddMenuProps) {
  if (!screenAvailable) {
    return <ImportButton onPress={onImport} disabled={disabled} busy={busy} progress={progress} />;
  }
  return (
    <PlusMenu
      actions={addMenuActions({ onImport, onRecordScreen })}
      enabled={!disabled && !busy}
      label="Add a clip"
      renderButton={(onPress) => (
        <ImportButton
          onPress={onPress}
          disabled={disabled}
          busy={busy}
          progress={progress}
          label="Add a clip"
        />
      )}
    />
  );
}
