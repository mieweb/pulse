import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { useTheme } from '@/hooks/use-theme';
import { haptics } from '@/utils/haptics';

/** Clips | Timeline: which way the draft's clips are shown below the preview. */
export function ViewSwitcher({
  view,
  onChange,
}: {
  view: 'clips' | 'timeline';
  onChange: (view: 'clips' | 'timeline') => void;
}) {
  const theme = useTheme();
  const options = [
    { key: 'clips', label: 'Clips', icon: 'rectangle.split.3x1' },
    { key: 'timeline', label: 'Timeline', icon: 'waveform' },
  ] as const;
  return (
    <View
      style={[styles.switcher, { backgroundColor: theme.backgroundElement }]}
      accessibilityRole="tablist">
      {options.map((o) => {
        const on = view === o.key;
        return (
          <Pressable
            key={o.key}
            onPress={() => {
              if (on) return;
              haptics.tap();
              onChange(o.key);
            }}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`${o.label} view`}
            style={[styles.switchOption, on && { backgroundColor: theme.text }]}>
            <Icon
              name={o.icon}
              size={16}
              weight="semibold"
              tintColor={on ? theme.background : theme.text}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/** A round header button: an icon, dimmed while pressed or disabled. */
export function HeaderButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.headerButton, (disabled || pressed) && styles.dim]}>
      <Icon name={icon} size={18} weight="semibold" tintColor={theme.text} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  switcher: {
    flexDirection: 'row',
    padding: 2,
    borderRadius: 17,
  },
  switchOption: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 44,
    height: 30,
    borderRadius: 15,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dim: { opacity: 0.35 },
});
