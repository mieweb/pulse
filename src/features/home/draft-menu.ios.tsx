import { Button, type ButtonProps, Host, Image, Menu } from '@expo/ui/swift-ui';
import { contentShape, frame, shapes } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/hooks/use-theme';

import { type DraftMenuProps, draftMenuActions } from './draft-menu-actions';

/**
 * The draft card's ⋯ button, as the iOS system menu: it opens from the button with the system's
 * glass, animation and dark mode, like every other app's ⋯ menu.
 */
export function DraftMenu(props: DraftMenuProps) {
  const theme = useTheme();
  const actions = draftMenuActions(props);
  return (
    // The card around it is a Pressable, and React Native hands a touch to the deepest view that
    // asks for it, else up to the card. The native menu isn't part of that system, so without
    // this a tap opened the draft (the card's press) along with the menu, and a hold reached the
    // card's long press too. Claiming the touch keeps the card out of it; the SwiftUI menu still
    // gets the native touch and opens on a tap.
    // Labelled here, as Android's ⋯ is: the SwiftUI glyph inside has no name of its own, so
    // VoiceOver read it as an unlabelled image.
    <View
      style={styles.trigger}
      onStartShouldSetResponder={() => true}
      accessibilityRole="button"
      accessibilityLabel="Draft options">
      <Host style={styles.fill}>
        <Menu
          label={
            // An 18 pt glyph in a 44 pt tappable frame (the HIG minimum); the whole frame hit-tests.
            <Image
              systemName="ellipsis"
              size={18}
              color={theme.textSecondary}
              modifiers={[
                frame({ width: TRIGGER_SIZE, height: TRIGGER_SIZE }),
                contentShape(shapes.rectangle()),
              ]}
            />
          }>
          {actions.map((action) => (
            <Button
              key={action.key}
              label={action.label}
              systemImage={action.icon as ButtonProps['systemImage']}
              role={action.destructive ? 'destructive' : 'default'}
              onPress={action.onPress}
            />
          ))}
        </Menu>
      </Host>
    </View>
  );
}

/** The trigger's tap frame. */
const TRIGGER_SIZE = 44;

const styles = StyleSheet.create({
  // Takes the 28 pt slot the card lays out (as Android's trigger), reaching past it to 44 pt: the
  // extra overhangs the card's padding, and only 4 pt toward the link button beside it.
  trigger: {
    width: TRIGGER_SIZE,
    height: TRIGGER_SIZE,
    marginVertical: -(TRIGGER_SIZE - 28) / 2,
    marginLeft: -4,
    marginRight: -(TRIGGER_SIZE - 28 - 4),
  },
  fill: { flex: 1 },
});
