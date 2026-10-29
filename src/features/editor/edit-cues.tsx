import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon } from '@/components/icon';
import type { ParsedEdit } from '@/utils/segment-window';

import { speedLabel } from './timeline-geometry';

const FLIP_ICON = 'arrow.left.and.right.righttriangle.left.righttriangle.right';

/**
 * What's been done to a clip, at a glance: its speed (when not 1x) and a glyph per edit (rotate,
 * flip, crop, and mute where asked). 'row' is one pill (a timeline clip); 'stack' centres them, for
 * a narrow thumbnail (which places the speed and the glyphs apart, by `part`). Nothing renders
 * for an unedited clip.
 */
export function EditCues({
  edit,
  layout,
  showMute,
  part = 'all',
  style,
}: {
  edit: ParsedEdit;
  layout: 'row' | 'stack';
  showMute: boolean;
  /** Only the speed, or only the glyphs (a thumbnail places them apart). */
  part?: 'all' | 'speed' | 'glyphs';
  style?: StyleProp<ViewStyle>;
}) {
  const speed = edit.speed !== 1 && part !== 'glyphs';
  const glyphs = (
    part === 'speed'
      ? []
      : [
          edit.rotation !== 0 && 'rotate.left',
          edit.flipped && FLIP_ICON,
          !!edit.crop && 'crop',
          showMute && edit.muted && 'speaker.slash.fill',
        ]
  ).filter((g): g is string => !!g);
  if (!speed && glyphs.length === 0) return null;

  const size = layout === 'row' ? 11 : 10;
  const icons = glyphs.map((g) => <Icon key={g} name={g as never} size={size} tintColor="#fff" />);
  const label = speed && <Text style={styles.speed}>{speedLabel(edit.speed)}</Text>;

  if (layout === 'row') {
    return (
      <View style={[styles.pill, styles.row, style]} pointerEvents="none">
        {label}
        {icons}
      </View>
    );
  }
  return (
    <View style={[styles.stack, style]} pointerEvents="none">
      {speed && <View style={styles.pill}>{label}</View>}
      {glyphs.length > 0 && <View style={[styles.pill, styles.row, styles.tight]}>{icons}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  tight: { gap: 2, paddingHorizontal: 3 },
  stack: { alignItems: 'center', gap: 2 },
  speed: { color: '#fff', fontSize: 10, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
