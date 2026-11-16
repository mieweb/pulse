import { useRef, useState } from 'react';
import { View } from 'react-native';

import { ActionMenu, type Anchor } from '@/components/action-menu';
import { canRecordScreen } from '@/features/screen-capture/screen-capture';

import { type AddMenuProps, addMenuActions } from './add-menu-actions';
import { ImportButton } from './import-button';

/**
 * The recorder's "+": Import video or Record screen, in a popover anchored to it (Android; iOS
 * uses the system menu, add-menu.ios.tsx). Without screen recording it's the plain import.
 */
export function AddMenu({
  onImport,
  onRecordScreen,
  screenAvailable,
  disabled,
  busy,
  progress,
}: AddMenuProps) {
  const ref = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const close = () => setAnchor(null);

  if (!canRecordScreen || !screenAvailable) {
    return <ImportButton onPress={onImport} disabled={disabled} busy={busy} progress={progress} />;
  }
  return (
    <>
      <View ref={ref} collapsable={false}>
        <ImportButton
          onPress={() =>
            ref.current?.measureInWindow((x, y, width, height) =>
              setAnchor({ x, y, width, height }),
            )
          }
          disabled={disabled}
          busy={busy}
          progress={progress}
          label="Add a clip"
        />
      </View>
      <ActionMenu
        visible={anchor !== null}
        anchor={anchor}
        // Each action closes the menu first, as the system menu does.
        actions={addMenuActions({ onImport, onRecordScreen }).map((a) => ({
          ...a,
          onPress: () => {
            close();
            a.onPress();
          },
        }))}
        onClose={close}
      />
    </>
  );
}
