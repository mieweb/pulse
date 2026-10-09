import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ActionMenu, type Anchor } from '@/components/action-menu';
import { Icon } from '@/components/icon';
import { useTheme } from '@/hooks/use-theme';

import { type DraftMenuProps, useDraftMenuActions } from './draft-menu-actions';

/**
 * The draft card's ⋯ button and its popover menu, anchored to the button (Android; iOS uses the
 * system menu, draft-menu.ios.tsx).
 */
export function DraftMenu(props: DraftMenuProps) {
  const theme = useTheme();
  const actions = useDraftMenuActions(props);
  const ref = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const close = () => setAnchor(null);

  return (
    <>
      <Pressable
        ref={ref}
        onPress={() =>
          ref.current?.measureInWindow((x, y, width, height) => setAnchor({ x, y, width, height }))
        }
        hitSlop={{ top: 10, bottom: 10, left: props.besidePill ? 2 : 10, right: 10 }}
        accessibilityRole="button"
        accessibilityLabel="Draft options"
        style={({ pressed }) => [styles.more, { opacity: pressed ? 0.6 : 1 }]}>
        <Icon name="ellipsis" size={18} tintColor={theme.textSecondary} />
      </Pressable>
      <ActionMenu
        visible={anchor !== null}
        anchor={anchor}
        // Each action closes the menu first, as the system menu does.
        actions={actions.map((a) => ({
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

const styles = StyleSheet.create({
  more: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
});
