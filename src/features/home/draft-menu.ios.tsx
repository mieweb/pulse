import { Button, type ButtonProps, Host, Image, Menu } from '@expo/ui/swift-ui';

import { useTheme } from '@/hooks/use-theme';

import { type DraftMenuProps, useDraftMenuActions } from './draft-menu-actions';

/**
 * The draft card's ⋯ button, as the iOS system menu: it opens from the button with the system's
 * glass, animation and dark mode, like every other app's ⋯ menu.
 */
export function DraftMenu(props: DraftMenuProps) {
  const theme = useTheme();
  const actions = useDraftMenuActions(props);
  return (
    <Host matchContents>
      <Menu label={<Image systemName="ellipsis" size={18} color={theme.textSecondary} />}>
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
