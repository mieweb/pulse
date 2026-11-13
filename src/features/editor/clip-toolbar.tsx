import { type ReactNode, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { Accent } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

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
  /** Working on it: a spinner in place of the glyph (still tappable). */
  busy?: boolean;
  /** A tip's anchor, laid over the glyph. */
  tip?: ReactNode;
};

function ToolButton({ tool }: { tool: Tool }) {
  const theme = useTheme();
  const color = tool.destructive ? Accent : theme.text;
  return (
    <Pressable
      onPress={tool.onPress}
      disabled={tool.disabled}
      accessibilityRole="button"
      accessibilityLabel={tool.label}
      accessibilityState={{ disabled: !!tool.disabled, busy: !!tool.busy }}
      hitSlop={4}
      style={({ pressed }) => [
        styles.tool,
        tool.disabled && styles.disabled,
        pressed && styles.pressed,
      ]}>
      <View style={styles.glyph}>
        {tool.busy ? (
          <ActivityIndicator size="small" color={color} />
        ) : tool.text ? (
          <Text style={[styles.glyphText, { color }]}>{tool.text}</Text>
        ) : (
          tool.icon && <Icon name={tool.icon} size={20} weight="medium" tintColor={color} />
        )}
        {tool.tip}
      </View>
      <Text style={[styles.label, { color }]} numberOfLines={1}>
        {tool.label}
      </Text>
    </Pressable>
  );
}

/** The clip under the playhead's tools (edit mode). */
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
  /** Leave edit mode. */
  onDone: () => void;
};

/** The clip tools: flip, rotate, crop, mute, speed, then reset and delete (✓ leaves edit mode).
 * They scroll sideways when the screen is too narrow for all of them. */
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
      <DoneButton label="Done editing" onPress={p.onDone} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollTools}>
        {tools.map((t) => (
          <ToolButton key={t.key} tool={t} />
        ))}
      </ScrollView>
    </View>
  );
}

/** ✓: back to the main tools. */
function DoneButton({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={[styles.done, { backgroundColor: theme.backgroundElement }]}>
      <Icon name="checkmark" size={18} weight="semibold" tintColor={theme.text} />
    </Pressable>
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
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <DoneButton label="Done" onPress={onDone} />
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
              style={[styles.chip, { backgroundColor: on ? theme.text : theme.backgroundElement }]}>
              <Text style={[styles.chipText, { color: on ? theme.background : theme.text }]}>
                {speedLabel(s)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** Outside the modes: the draft's tools. Each opens its mode (✓ there comes back). */
export function MainToolbar({
  canEdit,
  onEdit,
  captionsBusy,
  onCaptions,
  tip,
}: {
  /** Some clip can be edited (the draft has clips). */
  canEdit: boolean;
  /** Edit mode, on the clip under the playhead. */
  onEdit: () => void;
  /** The model downloading, or clips being transcribed. */
  captionsBusy: boolean;
  onCaptions: () => void;
  tip?: ReactNode;
}) {
  const tools: Tool[] = [
    { key: 'edit', label: 'Edit', icon: 'scissors', onPress: onEdit, disabled: !canEdit },
    {
      key: 'captions',
      label: 'Captions',
      icon: 'captions.bubble',
      onPress: onCaptions,
      busy: captionsBusy,
      tip,
    },
  ];
  return (
    <View style={[styles.row, styles.rowStart]}>
      {tools.map((t) => (
        <ToolButton key={t.key} tool={t} />
      ))}
    </View>
  );
}

/**
 * The captions tools: Edit and Delete act on the tapped word; Split and Merge on the sentence
 * under the playhead (Split cuts it at the word boundary nearest the playhead; Merge joins it with
 * the next one, or the two either side of a gap); then the model and Reset.
 */
export function CaptionToolbar(p: {
  /** A word is selected (tapped): what Edit and Delete act on. */
  hasWord: boolean;
  canSplit: boolean;
  canMerge: boolean;
  /** Some clip's captions were edited. */
  edited: boolean;
  onDone: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSplit: () => void;
  onMerge: () => void;
  onModel: () => void;
  onReset: () => void;
}) {
  const tools: Tool[] = [
    { key: 'edit', label: 'Edit', icon: 'pencil', onPress: p.onEdit, disabled: !p.hasWord },
    { key: 'split', label: 'Split', icon: 'scissors', onPress: p.onSplit, disabled: !p.canSplit },
    {
      key: 'merge',
      label: 'Merge',
      icon: 'arrow.triangle.merge',
      onPress: p.onMerge,
      disabled: !p.canMerge,
    },
    { key: 'model', label: 'Model', icon: 'wand.and.stars', onPress: p.onModel },
    {
      key: 'reset',
      label: 'Reset',
      icon: 'arrow.counterclockwise',
      onPress: p.onReset,
      disabled: !p.edited,
    },
    {
      key: 'delete',
      label: 'Delete',
      icon: 'trash',
      onPress: p.onDelete,
      disabled: !p.hasWord,
      destructive: true,
    },
  ];
  return (
    <View style={styles.row}>
      <DoneButton label="Done with captions" onPress={p.onDone} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollTools}>
        {tools.map((t) => (
          <ToolButton key={t.key} tool={t} />
        ))}
      </ScrollView>
    </View>
  );
}

/** A caption's words, typed (✓ keeps them, ✕ leaves them as they were). */
export function CaptionTextBar({
  initial,
  onDone,
  onCancel,
}: {
  initial: string;
  onDone: (text: string) => void;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const [text, setText] = useState(initial);
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        hitSlop={6}
        style={[styles.done, { backgroundColor: theme.backgroundElement }]}>
        <Icon name="xmark" size={16} weight="semibold" tintColor={theme.text} />
      </Pressable>
      <TextInput
        value={text}
        onChangeText={setText}
        autoFocus
        multiline={false}
        returnKeyType="done"
        onSubmitEditing={() => onDone(text)}
        placeholder="Caption"
        placeholderTextColor={theme.textSecondary}
        accessibilityLabel="Caption text"
        style={[styles.input, { color: theme.text, backgroundColor: theme.backgroundElement }]}
      />
      <Pressable
        onPress={() => onDone(text)}
        accessibilityRole="button"
        accessibilityLabel="Done"
        hitSlop={6}
        style={[styles.done, styles.doneEnd, { backgroundColor: theme.text }]}>
        <Icon name="checkmark" size={18} weight="semibold" tintColor={theme.background} />
      </Pressable>
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
  rowStart: { justifyContent: 'flex-start', paddingHorizontal: 12, gap: 16 },
  scrollTools: { flexGrow: 1, justifyContent: 'space-evenly', alignItems: 'center' },
  input: { flex: 1, height: 40, borderRadius: 20, paddingHorizontal: 16, fontSize: 16 },
  doneEnd: { marginRight: 0, marginLeft: 8 },
  // Each tool's own size (not a stretched share of the row), so the space between tools is
  // off-tool: a tap there lets the selection go instead of firing a tool.
  tool: { minWidth: 44, alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 2 },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.6 },
  glyph: { height: 24, justifyContent: 'center', alignItems: 'center' },
  glyphText: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  label: { fontSize: 11, fontWeight: '500' },
  done: {
    width: 40,
    height: 40,
    borderRadius: 20,
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
