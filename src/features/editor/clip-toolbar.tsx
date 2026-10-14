import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { Accent } from '@/constants/theme';

import { speedLabel } from './timeline-geometry';

export const TOOLBAR_HEIGHT = 60;
const FLIP_ICON = 'arrow.left.and.right.righttriangle.left.righttriangle.right';

type Tool = {
  key: string;
  label: string;
  icon?: IconName;
  /** A text glyph instead of an icon (the speed). */
  text?: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
};

function ToolButton({ tool }: { tool: Tool }) {
  const color = tool.destructive ? Accent : '#fff';
  return (
    <Pressable
      onPress={tool.onPress}
      disabled={tool.disabled}
      accessibilityRole="button"
      accessibilityLabel={tool.label}
      hitSlop={4}
      style={({ pressed }) => [
        styles.tool,
        tool.disabled && styles.disabled,
        pressed && styles.pressed,
      ]}>
      <View style={styles.glyph}>
        {tool.text ? (
          <Text style={styles.glyphText}>{tool.text}</Text>
        ) : (
          tool.icon && <Icon name={tool.icon} size={20} weight="medium" tintColor={color} />
        )}
      </View>
      <Text style={[styles.label, { color }]} numberOfLines={1}>
        {tool.label}
      </Text>
    </Pressable>
  );
}

/** The selected clip's tools (shown only while a clip is selected). */
type Props = {
  muted: boolean;
  speed: number;
  editable: boolean;
  edited: boolean;
  onFlip: () => void;
  onRotate: () => void;
  onCrop: () => void;
  onMute: () => void;
  onSpeed: () => void;
  onReset: () => void;
  onDelete: () => void;
};

/** The clip tools, in RNVT's order (flip, rotate, crop, mute, speed), then reset and delete. */
export function ClipToolbar(p: Props) {
  const tools: Tool[] = [
    { key: 'flip', label: 'Flip', icon: FLIP_ICON, onPress: p.onFlip, disabled: !p.editable },
    {
      key: 'rotate',
      label: 'Rotate',
      icon: 'rotate.left',
      onPress: p.onRotate,
      disabled: !p.editable,
    },
    { key: 'crop', label: 'Crop', icon: 'crop', onPress: p.onCrop, disabled: !p.editable },
    {
      key: 'mute',
      label: p.muted ? 'Unmute' : 'Mute',
      icon: p.muted ? 'speaker.slash.fill' : 'speaker.wave.2.fill',
      onPress: p.onMute,
      disabled: !p.editable,
    },
    {
      key: 'speed',
      label: 'Speed',
      text: speedLabel(p.speed),
      onPress: p.onSpeed,
      disabled: !p.editable,
    },
    {
      key: 'reset',
      label: 'Reset',
      icon: 'arrow.counterclockwise',
      onPress: p.onReset,
      disabled: !p.edited,
    },
    { key: 'delete', label: 'Delete', icon: 'trash', onPress: p.onDelete, destructive: true },
  ];
  return (
    <View style={styles.row}>
      {tools.map((t) => (
        <ToolButton key={t.key} tool={t} />
      ))}
    </View>
  );
}

/** The speed micro-mode: every speed one tap away, applied at once; ✓ goes back to the tools. */
export function SpeedRow({
  speeds,
  speed,
  onPick,
  onDone,
}: {
  speeds: readonly number[];
  speed: number;
  onPick: (speed: number) => void;
  onDone: () => void;
}) {
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onDone}
        accessibilityRole="button"
        accessibilityLabel="Done"
        hitSlop={6}
        style={styles.done}>
        <Icon name="checkmark" size={18} weight="semibold" tintColor="#fff" />
      </Pressable>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}>
        {speeds.map((s) => {
          const on = Math.abs(s - speed) < 0.0001;
          return (
            <Pressable
              key={s}
              onPress={() => onPick(s)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{speedLabel(s)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    height: TOOLBAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingHorizontal: 4,
  },
  // Each tool's own size (not a stretched share of the row), so the space between tools is
  // off-tool: a tap there lets the selection go instead of firing a tool.
  tool: { minWidth: 44, alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 2 },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.6 },
  glyph: { height: 24, justifyContent: 'center', alignItems: 'center' },
  glyphText: { color: '#fff', fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  label: { fontSize: 11, fontWeight: '500' },
  done: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#2C2C2E',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  chips: { gap: 8, alignItems: 'center', paddingRight: 8 },
  chip: {
    height: 34,
    minWidth: 52,
    paddingHorizontal: 12,
    borderRadius: 17,
    backgroundColor: '#2C2C2E',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: '#fff' },
  chipText: { color: '#fff', fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  chipTextOn: { color: '#000' },
});
