import {
  Button,
  HStack,
  Host,
  Image,
  Popover,
  Rectangle,
  Spacer,
  Text,
  VStack,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel,
  buttonStyle,
  contentShape,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  padding,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { MaxTextScale } from '@/constants/theme';
import { useTheme, useThemeMode } from '@/hooks/use-theme';

import { CalloutAnchor } from './tip-callout';
import { TIPS } from './tips';
import type { TipAnchorProps } from './tip-anchor-types';

/** The tip's width, as TipKit's popover tips on iPhone. */
const TIP_WIDTH = 300;
/** Padding around the tip's content; the ✕'s 44 pt target reaches into it. */
const PAD = 16;
const CLOSE = 44;

/**
 * A one-time tip pointing at whatever this is laid over. A `callout` tip is drawn by Pulse
 * (`tip-callout`); a `popover` tip is the iOS popover (SwiftUI's, kept a popover on iPhone), laid
 * out like TipKit's tips: a glyph, a title, a line of text and a close ✕.
 *
 * Drop it inside the control's wrapper; it fills that wrapper and lets every touch through to the
 * control, so it's only an anchor for the popover's arrow. A tap anywhere else closes the popover.
 */
export function TipAnchor({ id, shown, onDismiss, arrowEdge }: TipAnchorProps) {
  const theme = useTheme();
  const mode = useThemeMode();
  // SwiftUI's text styles follow every system text size; the app's text stops at `MaxTextScale`,
  // so the popover's text is sized here, the same way.
  const scale = Math.min(useWindowDimensions().fontScale, MaxTextScale);
  const tip = TIPS[id];

  if (tip.kind === 'callout') {
    return <CalloutAnchor id={id} shown={shown} onDismiss={onDismiss} />;
  }

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
              modifiers={[
                padding({ all: PAD }),
                frame({ width: TIP_WIDTH, alignment: 'leading' }),
              ]}>
              <Image systemName={tip.symbol} size={28 * scale} color={theme.accent} />
              <VStack alignment="leading" spacing={2}>
                <Text modifiers={[font({ size: 17 * scale, weight: 'semibold' })]}>
                  {tip.title}
                </Text>
                <Text
                  modifiers={[
                    font({ size: 15 * scale }),
                    foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
                    fixedSize({ horizontal: false, vertical: true }),
                  ]}>
                  {tip.message}
                </Text>
              </VStack>
              <Spacer minLength={0} />
              {/* A button, so it highlights on touch-down, with a 44 pt target: the negative
                  padding lets the target reach into the tip's padding without widening it. */}
              <Button
                onPress={onDismiss}
                modifiers={[
                  buttonStyle('plain'),
                  frame({ width: CLOSE, height: CLOSE }),
                  contentShape(shapes.rectangle()),
                  padding({ top: -PAD, trailing: -PAD, bottom: -CLOSE / 2 }),
                  accessibilityLabel('Close tip'),
                ]}>
                <Image
                  systemName="xmark"
                  size={13 * scale}
                  modifiers={[foregroundStyle({ type: 'hierarchical', style: 'tertiary' })]}
                />
              </Button>
            </HStack>
          </Popover.Content>
        </Popover>
      </Host>
    </View>
  );
}
