import { Pressable, StyleSheet, Text } from 'react-native';
import Animated from 'react-native-reanimated';

import { GlassPill } from '@/components/glass-pill';
import { Opacity } from '@/constants/theme';
import { haptics } from '@/utils/haptics';
import { CONTROLS_FADE } from './record-button';

/**
 * A selectable lens, expressed as a zoom factor on the (possibly multi-camera) device.
 * VisionCamera switches the underlying physical lens automatically as the zoom factor crosses
 * the device's `zoomLensSwitchFactors`, so "0.5x / 1x / Tele" are just zoom presets.
 */
export type LensPreset = { label: string; zoom: number };

/** The label of the neutral 1x lens — the default selection and the reset target on flip. */
export const DEFAULT_LENS_LABEL = '1x';

/**
 * Lens chips above the record button (e.g. 0.5x · 1x · Tele). Renders nothing when the current
 * device exposes fewer than two presets (e.g. a single-lens front camera).
 */
export function LensSelector({
  presets,
  selected,
  onSelect,
  disabled,
}: {
  presets: LensPreset[];
  selected: string | undefined;
  onSelect: (preset: LensPreset) => void;
  disabled: boolean;
}) {
  if (presets.length < 2) return null;

  const active = selected ?? DEFAULT_LENS_LABEL;

  return (
    <GlassPill style={styles.row}>
      {presets.map((preset) => (
        // The chips dim, never the pill: a partly transparent ancestor makes iOS draw the glass
        // flat. The disabled dim fades with the record controls (a recording locks the lens as it
        // starts); the press dim answers the finger at once.
        <Animated.View
          key={preset.label}
          style={[CONTROLS_FADE, { opacity: disabled ? Opacity.disabled : 1 }]}>
          <Pressable
            onPress={() => {
              // The tap confirms a lens change; the chip that's already on changes nothing (it
              // still re-centres a zoom that drifted inside that lens's range).
              if (preset.label !== active) haptics.tap();
              onSelect(preset);
            }}
            disabled={disabled}
            // 28pt chip + 8 top/bottom = a 44pt tap target; sideways only half the 6pt gap, so
            // neighbouring chips' targets never overlap.
            hitSlop={{ top: 8, bottom: 8, left: 3, right: 3 }}
            accessibilityRole="button"
            accessibilityLabel={`Lens ${preset.label}`}
            accessibilityState={{ selected: preset.label === active, disabled }}
            style={({ pressed }) => [
              styles.chip,
              preset.label === active && styles.chipActive,
              pressed && styles.pressed,
            ]}>
            {/* The chip is a fixed 28 pt over live video — it grows with the text only so far. */}
            <Text
              style={[styles.label, preset.label === active && styles.labelActive]}
              maxFontSizeMultiplier={1.3}>
              {preset.label}
            </Text>
          </Pressable>
        </Animated.View>
      ))}
    </GlassPill>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 6,
    padding: 4,
    borderRadius: 20,
  },
  chip: {
    minWidth: 36,
    height: 28,
    borderRadius: 14,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: '#fff' },
  pressed: { opacity: Opacity.pressed },
  label: { color: '#fff', fontSize: 12, fontWeight: '600' },
  labelActive: { color: '#000' },
});
