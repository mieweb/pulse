import { type ReactNode, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  type ScrollViewProps,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { Accent, MaxTextScale } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { speedLabel } from './timeline-geometry';

export const TOOLBAR_HEIGHT = 60;
const FLIP_ICON = 'arrow.left.and.right.righttriangle.left.righttriangle.right';

type Tool = {
  key: string;
  label: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
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
      accessibilityLabel={tool.accessibilityLabel ?? tool.label}
      accessibilityHint={tool.accessibilityHint}
      accessibilityState={{ disabled: !!tool.disabled, busy: !!tool.busy }}
      style={({ pressed }) => [
        styles.tool,
        tool.disabled && styles.disabled,
        pressed && styles.pressed,
      ]}>
      <View style={styles.glyph}>
        {tool.busy ? (
          <ActivityIndicator size="small" color={color} />
        ) : tool.text ? (
          <Text style={[styles.glyphText, { color }]} maxFontSizeMultiplier={1.3}>
            {tool.text}
          </Text>
        ) : (
          tool.icon && <Icon name={tool.icon} size={20} weight="medium" tintColor={color} />
        )}
        {tool.tip}
      </View>
      <Text
        style={[styles.label, { color }]}
        numberOfLines={1}
        maxFontSizeMultiplier={MaxTextScale}>
        {tool.label}
      </Text>
    </Pressable>
  );
}

/** Scroll with a gesture or a button; Done remains reachable without a required swipe. */
function ScrollableTools({
  children,
  contentContainerStyle = styles.scrollTools,
}: {
  children: ReactNode;
  contentContainerStyle?: ScrollViewProps['contentContainerStyle'];
}) {
  const scroll = useRef<ScrollView>(null);
  const offset = useRef(0);
  const [contentWidth, setContentWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [atEnd, setAtEnd] = useState(false);
  return (
    <>
      <ScrollView
        ref={scroll}
        horizontal
        style={styles.scroll}
        contentContainerStyle={contentContainerStyle}
        onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}
        onContentSizeChange={(width) => setContentWidth(width)}
        onScroll={({ nativeEvent }) => {
          offset.current = nativeEvent.contentOffset.x;
          setAtEnd(
            offset.current + nativeEvent.layoutMeasurement.width >=
              nativeEvent.contentSize.width - 4,
          );
        }}
        scrollEventThrottle={16}>
        {children}
      </ScrollView>
      {contentWidth > viewportWidth + 1 && (
        <ToolButton
          tool={{
            key: 'scroll',
            label: atEnd ? 'First' : 'More',
            accessibilityLabel: atEnd ? 'Show first tools' : 'Show more tools',
            icon: 'ellipsis',
            onPress: () => {
              const end = Math.max(0, contentWidth - viewportWidth);
              // Half-page overlap keeps enlarged labels fully reachable between pages.
              const next = Math.min(end, offset.current + Math.max(44, viewportWidth / 2));
              scroll.current?.scrollTo({ x: atEnd ? 0 : next, animated: true });
            },
          }}
        />
      )}
    </>
  );
}

function splitTool(canSplit: boolean, onSplit: () => void): Tool {
  return {
    key: 'split',
    label: 'Split',
    accessibilityLabel: 'Split at playhead',
    icon: 'scissors',
    onPress: onSplit,
    disabled: !canSplit,
  };
}

/** The clip under the playhead's tools (edit mode). */
type Props = {
  muted: boolean;
  speed: number;
  editable: boolean;
  edited: boolean;
  canSplit: boolean;
  busy: boolean;
  onSplit: () => void;
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

/** Frequent edits come first; ✓ and the tools scroll together across the full row. */
export function ClipToolbar(p: Props) {
  const tools: Tool[] = [
    { key: 'delete', label: 'Delete', icon: 'trash', onPress: p.onDelete, destructive: true },
    splitTool(p.canSplit, p.onSplit),
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
    { key: 'crop', label: 'Crop', icon: 'crop', onPress: p.onCrop, disabled: !p.editable },
    {
      key: 'mute',
      label: p.muted ? 'Unmute' : 'Mute',
      icon: p.muted ? 'speaker.slash.fill' : 'speaker.wave.2.fill',
      onPress: p.onMute,
      disabled: !p.editable,
    },
    { key: 'flip', label: 'Flip', icon: FLIP_ICON, onPress: p.onFlip, disabled: !p.editable },
    {
      key: 'rotate',
      label: 'Rotate',
      icon: 'rotate.left',
      onPress: p.onRotate,
      disabled: !p.editable,
    },
  ];
  return (
    <View style={styles.row}>
      <ScrollableTools>
        <DoneButton label="Done editing" onPress={p.onDone} />
        {tools.map((t) => (
          <ToolButton key={t.key} tool={{ ...t, disabled: p.busy || t.disabled }} />
        ))}
      </ScrollableTools>
    </View>
  );
}

/** ✓: back to the main tools. */
function DoneButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
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
      <ScrollableTools contentContainerStyle={styles.chips}>
        <DoneButton label="Done" onPress={onDone} />
        {speeds.map((s) => {
          const on = Math.abs(s - speed) < 0.0001;
          return (
            <Pressable
              key={s}
              onPress={() => onPick(s)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[styles.chip, { backgroundColor: on ? theme.text : theme.backgroundElement }]}>
              <Text
                style={[styles.chipText, { color: on ? theme.background : theme.text }]}
                maxFontSizeMultiplier={MaxTextScale}>
                {speedLabel(s)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollableTools>
    </View>
  );
}

/** Outside the modes: split directly, or open Edit/Captions (✓ there comes back). */
export function MainToolbar({
  canEdit,
  onEdit,
  canSplit,
  onSplit,
  captionsBusy,
  onCaptions,
  onTranscript,
  tip,
}: {
  /** Some clip can be edited (the draft has clips). */
  canEdit: boolean;
  /** Edit mode, on the clip under the playhead. */
  onEdit: () => void;
  /** Split the clip under the playhead without entering Edit. */
  canSplit: boolean;
  onSplit: () => void;
  /** The model downloading, or clips being transcribed. */
  captionsBusy: boolean;
  onCaptions: () => void;
  onTranscript: () => void;
  tip?: ReactNode;
}) {
  const tools: Tool[] = [
    { key: 'edit', label: 'Edit', icon: 'pencil', onPress: onEdit, disabled: !canEdit },
    {
      key: 'transcript',
      label: 'Transcript',
      icon: 'text.alignleft',
      onPress: onTranscript,
      disabled: !canEdit,
    },
    splitTool(canSplit, onSplit),
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
    <View style={styles.row}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.mainTools}>
        {tools.map((t) => (
          <ToolButton key={t.key} tool={t} />
        ))}
      </ScrollView>
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
  busy: boolean;
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
      label: 'Hide word',
      accessibilityLabel: 'Hide selected caption word',
      accessibilityHint: 'Changes captions only. Keeps the recorded audio and video.',
      icon: 'trash',
      onPress: p.onDelete,
      disabled: !p.hasWord,
      destructive: true,
    },
  ];
  return (
    <View style={styles.row}>
      <ScrollableTools>
        <DoneButton label="Done with captions" onPress={p.onDone} disabled={p.busy} />
        {tools.map((t) => (
          <ToolButton key={t.key} tool={{ ...t, disabled: p.busy || t.disabled }} />
        ))}
      </ScrollableTools>
    </View>
  );
}

/** A caption's words, typed (✓ keeps them, ✕ leaves them as they were). */
export function CaptionTextBar({
  initial,
  onDone,
  onCancel,
  onChange,
}: {
  initial: string;
  onDone: (text: string) => void;
  onCancel: () => void;
  /** The text as it's typed (so a tap elsewhere can keep it). */
  onChange?: (text: string) => void;
}) {
  const theme = useTheme();
  const [text, setText] = useState(initial);
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onCancel}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={[styles.done, { backgroundColor: theme.backgroundElement }]}>
        <Icon name="xmark" size={16} weight="semibold" tintColor={theme.text} />
      </Pressable>
      <TextInput
        value={text}
        onChangeText={(t) => {
          setText(t);
          onChange?.(t);
        }}
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
        style={[styles.done, styles.doneEnd, { backgroundColor: theme.text }]}>
        <Icon name="checkmark" size={18} weight="semibold" tintColor={theme.background} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: TOOLBAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    paddingHorizontal: 4,
  },
  mainTools: { flexGrow: 1, alignItems: 'center', gap: 4 },
  scroll: { flex: 1, minWidth: 0 },
  scrollTools: { flexGrow: 1, gap: 8, justifyContent: 'space-evenly', alignItems: 'center' },
  input: { flex: 1, height: 40, borderRadius: 20, paddingHorizontal: 16, fontSize: 16 },
  doneEnd: { marginRight: 0, marginLeft: 8 },
  // Gaps let a swipe begin without activating a tool.
  tool: {
    minWidth: 52,
    minHeight: 44,
    flexShrink: 0,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.6 },
  glyph: { minHeight: 24, justifyContent: 'center', alignItems: 'center' },
  glyphText: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  label: { fontSize: 11, fontWeight: '500' },
  done: {
    width: 44,
    height: 44,
    borderRadius: 22,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chips: { gap: 8, alignItems: 'center', paddingRight: 8 },
  chip: {
    minHeight: 44,
    minWidth: 52,
    paddingHorizontal: 12,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
