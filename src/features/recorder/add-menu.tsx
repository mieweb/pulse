import { type AddMenuProps, addMenuActions } from './add-menu-actions';
import { ImportButton } from './import-button';
import { PlusMenu } from './plus-menu';

/**
 * The recorder's "+": Record screen where it's offered, Import video, Import image or screenshot,
 * and From another Pulse while another draft has clips (the shared `PlusMenu`: the iOS system
 * menu, an Android popover).
 */
export function AddMenu({
  onImport,
  onImportImages,
  onRecordScreen,
  screenAvailable,
  onFromAnotherPulse,
  disabled,
  busy,
  progress,
  progressText,
}: AddMenuProps) {
  return (
    <PlusMenu
      actions={addMenuActions({
        onImport,
        onImportImages,
        onRecordScreen,
        screenAvailable,
        onFromAnotherPulse,
      })}
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
