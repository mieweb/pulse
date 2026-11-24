import { Button, type ButtonProps, Host, Image, Menu } from '@expo/ui/swift-ui';
import {
  accessibilityHint,
  accessibilityLabel,
  contentShape,
  frame,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

import type { PlusMenuProps } from './add-menu-actions';

/**
 * A "+" that opens a list of ways to add clips, in the iOS system menu.
 *
 * The "+" you see is always the plain button, so it never changes or disappears: iOS hides a
 * menu's own label while the menu is open (the menu grows out of it), and swapping between the
 * menu and the plain button flashed. The menu sits on top with an invisible label and opens from
 * the same spot; it's there only while the "+" can be used (`enabled`).
 */
export function PlusMenu({
  actions,
  enabled,
  onOpen,
  renderButton,
  label,
  hint,
  size = 44,
}: PlusMenuProps) {
  return (
    <View style={{ width: size, height: size }}>
      {/* Hidden from VoiceOver while the menu above it is the control. */}
      <View
        accessibilityElementsHidden={enabled}
        importantForAccessibility={enabled ? 'no-hide-descendants' : 'auto'}>
        {renderButton(() => {})}
      </View>
      {enabled && (
        // Claims the touch so it doesn't reach the gestures under it (the camera's, the clips');
        // the SwiftUI menu still gets the native touch. Not an accessibility element itself: a
        // labelled RN View here was skipped by VoiceOver (it wasn't `accessible`) and, if made
        // one, its activation wouldn't open the SwiftUI menu. The menu below carries the name.
        <View
          style={StyleSheet.absoluteFill}
          onStartShouldSetResponder={() => true}
          // The finger is down on the "+": the system menu opens on its own, with no callback.
          onResponderGrant={onOpen}>
          <Host style={styles.fill}>
            <Menu
              // VoiceOver reads the menu as the "+" and a double tap opens it natively.
              modifiers={[accessibilityLabel(label), ...(hint ? [accessibilityHint(hint)] : [])]}
              label={
                // Invisible but hit-testable (a fully transparent SwiftUI view isn't): the circle
                // is the tap area, and the plain "+" under it is what shows.
                <Image
                  systemName="plus"
                  color="#FFFFFF01"
                  modifiers={[frame({ width: size, height: size }), contentShape(shapes.circle())]}
                />
              }>
              {actions.map((action) => (
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

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
