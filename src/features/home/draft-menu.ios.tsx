import { Button, type ButtonProps, Host, Image, Menu } from '@expo/ui/swift-ui';
import { contentShape, frame, shapes } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet } from 'react-native';

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
    <Host style={styles.trigger}>
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
  );
}

/** The trigger's tap frame. */
const TRIGGER_SIZE = 44;

const styles = StyleSheet.create({
  // Takes the 28 pt slot the card lays out (as Android's trigger), reaching past it to 44 pt: the
  // extra overhangs the card's padding, and only 4 pt toward the link pill beside it.
  trigger: {
    width: TRIGGER_SIZE,
    height: TRIGGER_SIZE,
    marginVertical: -(TRIGGER_SIZE - 28) / 2,
    marginLeft: -4,
    marginRight: -(TRIGGER_SIZE - 28 - 4),
  },
});
