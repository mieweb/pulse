import { HStack, Host, Image, Popover, Rectangle, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';

import { useTheme, useThemeMode } from '@/hooks/use-theme';

import { TIPS } from './tips';
import type { TipAnchorProps } from './tip-anchor-types';

/** The tip's text column, as wide as TipKit's popover tips on iPhone. */
const TIP_WIDTH = 300;

/**
 * A one-time tip pointing at whatever this is laid over: the iOS popover (SwiftUI's, kept a
 * popover on iPhone), styled like TipKit's tips: a glyph, a title, a line of text and a close ✕.
 *
 * Drop it inside the control's wrapper; it fills that wrapper and lets every touch through to the
 * control, so it's only an anchor for the popover's arrow. A tap anywhere else closes the tip.
 */
export function TipAnchor({ id, shown, onDismiss, arrowEdge }: TipAnchorProps) {
  const theme = useTheme();
  const mode = useThemeMode();
  const tip = TIPS[id];
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Host style={StyleSheet.absoluteFill} colorScheme={mode}>
        <Popover
          isPresented={shown}
          onIsPresentedChange={(presented) => {
            if (!presented) onDismiss();
          }}
          arrowEdge={arrowEdge}>
          <Popover.Trigger>
            <Rectangle modifiers={[foregroundStyle('transparent')]} />
          </Popover.Trigger>
          <Popover.Content>
            <HStack
              alignment="top"
              spacing={12}
              modifiers={[padding({ all: 16 }), frame({ width: TIP_WIDTH, alignment: 'leading' })]}>
              <Image systemName={tip.symbol} size={28} color={theme.accent} />
              <VStack alignment="leading" spacing={2}>
                <Text modifiers={[font({ textStyle: 'headline' })]}>{tip.title}</Text>
                <Text
                  modifiers={[
                    font({ textStyle: 'subheadline' }),
                    foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
                    fixedSize({ horizontal: false, vertical: true }),
                  ]}>
                  {tip.message}
                </Text>
              </VStack>
              <Spacer minLength={0} />
              <Image
                systemName="xmark"
                size={13}
                color={theme.textSecondary}
                onPress={onDismiss}
                modifiers={[padding({ all: 4 }), accessibilityLabel('Close tip')]}
              />
            </HStack>
          </Popover.Content>
        </Popover>
      </Host>
    </View>
  );
}
