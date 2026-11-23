import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { ActionMenu, type Anchor } from '@/components/action-menu';

import type { PlusMenuProps } from './add-menu-actions';

/**
 * A "+" that opens a list of ways to add clips, in a popover anchored to it (Android; iOS uses the
 * system menu, plus-menu.ios.tsx). With one item the "+" is that item, no one-item menu. The
 * recorder's and the editor's "+" are both this, each with its own items and button.
 */
export function PlusMenu({ actions, enabled, renderButton }: PlusMenuProps) {
  const ref = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const close = () => setAnchor(null);
  // A tap asks for the menu; it opens once the "+" is measured (in an effect, off the render).
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (!asked) return;
    ref.current?.measureInWindow((x, y, width, height) => setAnchor({ x, y, width, height }));
  }, [asked]);

  if (actions.length <= 1) return renderButton(() => actions[0]?.onPress());
  return (
    <>
      <View ref={ref} collapsable={false}>
        {renderButton(() => {
          if (enabled) setAsked((n) => n + 1);
        })}
      </View>
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
