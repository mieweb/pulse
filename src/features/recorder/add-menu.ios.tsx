import { Button, type ButtonProps, Host, Image, Menu } from '@expo/ui/swift-ui';
import { contentShape, frame, shapes } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

import { canRecordScreen } from '@/features/screen-capture/screen-capture';

import { type AddMenuProps, addMenuActions } from './add-menu-actions';
import { ImportButton } from './import-button';

/**
 * The recorder's "+" with the iOS system menu: Import video or Record screen.
 *
 * The "+" you see is always the plain control, so it never changes or disappears: iOS hides a
 * menu's own label while the menu is open (the menu grows out of it), and swapping between the
 * menu and the plain control flashed. The menu sits on top with an invisible label and opens from
 * the same spot; it's there only while the "+" can be used (not during a take, a drag or an
 * import). Without screen recording a tap imports, as before.
 */
export function AddMenu({
  onImport,
  onRecordScreen,
  screenAvailable,
  disabled,
  busy,
  progress,
}: AddMenuProps) {
  const menu = canRecordScreen && screenAvailable && !disabled && !busy;
  return (
    <View style={styles.trigger}>
      {/* Hidden from VoiceOver while the menu above it is the control. */}
      <View
        accessibilityElementsHidden={menu}
        importantForAccessibility={menu ? 'no-hide-descendants' : 'auto'}>
        <ImportButton
          onPress={onImport}
          disabled={disabled}
          busy={busy}
          progress={progress}
          label={canRecordScreen && screenAvailable ? 'Add a clip' : undefined}
        />
      </View>
      {menu && (
        // Claims the touch so it doesn't reach the camera's gestures under it; the SwiftUI menu
        // still gets the native touch. Labelled here: the glyph inside has no name of its own.
        <View
          style={StyleSheet.absoluteFill}
          onStartShouldSetResponder={() => true}
          accessibilityRole="button"
          accessibilityLabel="Add a clip">
          <Host style={styles.fill}>
            <Menu
              label={
                // Invisible but hit-testable (a fully transparent SwiftUI view isn't): the circle
                // is the tap area, and the plain "+" under it is what shows.
                <Image
                  systemName="plus"
                  color="#FFFFFF01"
                  modifiers={[frame({ width: SIZE, height: SIZE }), contentShape(shapes.circle())]}
                />
              }>
              {addMenuActions({ onImport, onRecordScreen }).map((action) => (
                <Button
                  key={action.key}
                  label={action.label}
                  systemImage={action.icon as ButtonProps['systemImage']}
                  onPress={action.onPress}
                />
              ))}
            </Menu>
          </Host>
        </View>
      )}
    </View>
  );
}

/** The "+" circle, as `ImportButton` draws it. */
const SIZE = 44;

const styles = StyleSheet.create({
  trigger: { width: SIZE, height: SIZE },
  fill: { flex: 1 },
});
