import { type AddMenuProps, addMenuActions } from './add-menu-actions';
import { ImportButton } from './import-button';
import { PlusMenu } from './plus-menu';

/**
 * The recorder's "+": Import video, Import image or screenshot, or Record screen where it's
 * offered (the shared `PlusMenu`: the iOS system menu, an Android popover).
 */
export function AddMenu({
  onImport,
  onImportImages,
  onRecordScreen,
  screenAvailable,
  disabled,
  busy,
  progress,
  progressText,
}: AddMenuProps) {
  return (
    <PlusMenu
      actions={addMenuActions({ onImport, onImportImages, onRecordScreen, screenAvailable })}
      enabled={!disabled && !busy}
      label="Add a clip"
      renderButton={(onPress) => (
        <ImportButton
          onPress={onPress}
          disabled={disabled}
          busy={busy}
          progress={progress}
          progressText={progressText}
          label="Add a clip"
        />
      )}
    />
  );
}
