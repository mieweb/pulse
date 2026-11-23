import { type AddMenuProps, addMenuActions } from './add-menu-actions';
import { ImportButton } from './import-button';
import { PlusMenu } from './plus-menu';

/**
 * The recorder's "+": Import video, Record screen or From another Pulse (the shared `PlusMenu`: the
 * iOS system menu, an Android popover). With import the only item a tap imports, as before.
 */
export function AddMenu({
  onImport,
  onRecordScreen,
  screenAvailable,
  onFromAnotherPulse,
  disabled,
  busy,
  progress,
}: AddMenuProps) {
  const actions = addMenuActions({ onImport, onRecordScreen, screenAvailable, onFromAnotherPulse });
  if (actions.length === 1) {
    return <ImportButton onPress={onImport} disabled={disabled} busy={busy} progress={progress} />;
  }
  return (
    <PlusMenu
      actions={actions}
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
