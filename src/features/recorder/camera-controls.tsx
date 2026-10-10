import type { SymbolViewProps } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icon';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { GlassPill } from '@/components/glass-pill';
import { useTextSizeKey } from '@/hooks/use-text-size-key';
import { Accent, Opacity, Spacing } from '@/constants/theme';
import { haptics } from '@/utils/haptics';
import { CONTROLS_FADE } from './record-button';
import type { CameraFacing, StabilizationMode } from './use-recorder';

const STABILIZATION_LABELS: Record<StabilizationMode, string> = {
  off: 'Off',
  standard: 'On',
  cinematic: 'High',
  auto: 'Auto',
};

// One constant glyph anchors the four states as a single cycling setting (like torch/mic);
// state is carried by tint + caption. 'gyroscope' has no .slash variant, so Off dims the glyph.
const STABILIZATION_ICON: SymbolViewProps['name'] = 'gyroscope';

type Props = {
  facing: CameraFacing;
  torch: boolean;
  stabilization: StabilizationMode;
  muted: boolean;
  // A phone call holds the mic — audio is forced off and the toggle is locked while it lasts.
  callActive?: boolean;
  disabled?: boolean;
  onFlip: () => void;
  onToggleTorch: () => void;
  onCycleStabilization: () => void;
  onToggleMute: () => void;
};

export function CameraControls({
  facing,
  torch,
  stabilization,
  muted,
  callActive = false,
  disabled = false,
  onFlip,
  onToggleTorch,
  onCycleStabilization,
  onToggleMute,
}: Props) {
  return (
    <View style={styles.rail} pointerEvents="box-none">
      <ControlButton
        icon="arrow.triangle.2.circlepath.camera"
        label="Flip camera"
        disabled={disabled}
        onPress={onFlip}
      />
      <ControlButton
        icon={torch ? 'bolt.fill' : 'bolt.slash.fill'}
        label={torch ? 'Turn off flash' : 'Turn on flash'}
        tint={torch ? Accent : '#fff'}
        disabled={disabled || facing === 'front'}
        onPress={onToggleTorch}
      />
      <ControlButton
        icon={STABILIZATION_ICON}
        label={`Stabilization: ${STABILIZATION_LABELS[stabilization]}`}
        caption={STABILIZATION_LABELS[stabilization]}
        tint={stabilization === 'off' ? '#fff' : Accent}
        dimmed={stabilization === 'off'}
        disabled={disabled}
        onPress={onCycleStabilization}
      />
      <ControlButton
        icon={muted || callActive ? 'mic.slash.fill' : 'mic.fill'}
        label={
          callActive
            ? 'Microphone unavailable during a call'
            : muted
              ? 'Unmute recording audio'
              : 'Mute recording audio'
        }
        // Surface WHY the mic is off during a call so it doesn't look like a bug; the toggle is
        // locked because the OS, not the user, owns the mic while telephony has it.
        caption={callActive ? 'On call' : undefined}
        tint={muted || callActive ? Accent : '#fff'}
        disabled={disabled || callActive}
        onPress={onToggleMute}
      />
    </View>
  );
}

function ControlButton({
  icon,
  label,
  onPress,
  tint = '#fff',
  caption,
  dimmed = false,
  disabled = false,
}: {
  icon: SymbolViewProps['name'];
  label: string;
  onPress: () => void;
  tint?: string;
  caption?: string;
  // Fades only the glyph (not the pill) — "this feature, disabled" without reading as an inert button.
  dimmed?: boolean;
  disabled?: boolean;
}) {
  const textSizeKey = useTextSizeKey();
  return (
    <Pressable
      onPress={() => {
        // A camera setting changed: the same tap as a lens chip. (The rail is locked while a clip
        // records, when haptics are muted anyway.)
        haptics.tap();
        onPress();
      }}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles.wrap}>
      {({ pressed }) => (
        <>
          <GlassPill style={styles.button}>
            <Dim disabled={disabled} pressed={pressed}>
              <Icon
                name={icon}
                size={24}
                weight="medium"
                tintColor={tint}
                style={dimmed ? styles.dimmedIcon : undefined}
              />
            </Dim>
          </GlassPill>
          {caption && (
            <Dim disabled={disabled} pressed={pressed}>
              <Text
                key={textSizeKey}
                style={[styles.caption, { color: tint }]}
                maxFontSizeMultiplier={1.3}>
                {caption}
              </Text>
            </Dim>
          )}
        </>
      )}
    </Pressable>
  );
}

/**
 * Press and disabled dimming for what's INSIDE a glass pill (and the caption under it), never the
 * pill: a partly transparent ancestor makes iOS draw the glass flat, and it can stay that way. The
 * disabled dim fades with the record controls (a recording locks the rail as it starts); the press
 * dim answers the finger at once.
 */
function Dim({
  disabled,
  pressed,
  children,
}: {
  disabled: boolean;
  pressed: boolean;
  children: ReactNode;
}) {
  return (
    <Animated.View style={[CONTROLS_FADE, { opacity: disabled ? Opacity.disabled : 1 }]}>
      <View style={pressed && styles.pressed}>{children}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Spans the full height with the buttons centered, then nudged up a bit — dead center
  // reads too low against the bottom-heavy recorder UI (segment bar + record button).
  rail: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: Spacing.three,
    justifyContent: 'center',
    gap: Spacing.three,
    alignItems: 'center',
    paddingBottom: 120,
  },
  wrap: { alignItems: 'center', gap: 2 },
  button: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  // Over live video: the shadow keeps the caption readable on a bright scene.
  caption: {
    fontSize: 11,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 2,
    textShadowOffset: { width: 0, height: 1 },
  },
  // Distinct from the disabled treatment, which dims the caption too.
  dimmedIcon: { opacity: 0.45 },
  pressed: { opacity: Opacity.pressed },
});
