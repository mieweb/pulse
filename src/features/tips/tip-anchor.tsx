import { Host, Spacer, Text, TooltipBox, type TooltipBoxRef } from '@expo/ui/jetpack-compose';
import { fillMaxSize } from '@expo/ui/jetpack-compose/modifiers';
import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemeMode } from '@/hooks/use-theme';

import { TIPS } from './tips';
import type { TipAnchorProps } from './tip-anchor-types';

/**
 * A one-time tip pointing at whatever this is laid over: Material 3's rich tooltip, Android's
 * counterpart of an iOS popover tip (a title and a line of text). It stays until a tap elsewhere
 * closes it.
 *
 * Drop it inside the control's wrapper; it fills that wrapper and lets every touch through to the
 * control, so it's only the tooltip's anchor.
 */
export function TipAnchor({ id, shown, onDismiss }: TipAnchorProps) {
  const mode = useThemeMode();
  const ref = useRef<TooltipBoxRef>(null);
  const tip = TIPS[id];

  useEffect(() => {
    if (!shown) return;
    // A persistent tooltip's `show()` settles when it closes, however it closes.
    const tooltip = ref.current;
    let open = true;
    // Either call rejects once the view is gone (its tip closing as the screen does): nothing to do.
    void tooltip
      ?.show()
      .catch(() => {})
      .then(() => {
        if (open) onDismiss();
      });
    return () => {
      open = false;
      void tooltip?.dismiss().catch(() => {});
    };
  }, [shown, onDismiss]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Host style={StyleSheet.absoluteFill} colorScheme={mode}>
        <TooltipBox ref={ref} isPersistent enableUserInput={false}>
          <TooltipBox.RichTooltip>
            <TooltipBox.RichTooltip.Title>
              <Text>{tip.title}</Text>
            </TooltipBox.RichTooltip.Title>
            <TooltipBox.RichTooltip.Text>
              <Text>{tip.message}</Text>
            </TooltipBox.RichTooltip.Text>
          </TooltipBox.RichTooltip>
          <Spacer modifiers={[fillMaxSize()]} />
        </TooltipBox>
      </Host>
    </View>
  );
}
