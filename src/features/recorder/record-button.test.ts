import { describe, expect, it, jest } from '@jest/globals';
import type { AccessibilityActionEvent } from 'react-native';

import { recordButtonA11y } from './record-button';

// The button's module draws with Reanimated and RNGH; only its accessibility props are tested.
jest.mock('react-native', () => ({ StyleSheet: { create: <T>(styles: T) => styles } }));
jest.mock('react-native-gesture-handler', () => ({ GestureDetector: () => null }));
jest.mock('react-native-reanimated', () => ({ __esModule: true, default: { View: () => null } }));
jest.mock('@/constants/theme', () => ({ Accent: '#f00', Opacity: { disabled: 0.4 } }));
jest.mock('@/constants/motion', () => ({ EaseOut: null, EaseOutCss: 'ease-out' }));
jest.mock('@/features/recorder/track-metrics', () => ({ RECORD_BUTTON_SIZE: 80 }));

const action = (actionName: string) =>
  ({ nativeEvent: { actionName } }) as AccessibilityActionEvent;

describe('recordButtonA11y', () => {
  it("a screen reader's activation toggles the take, as a tap does", () => {
    const onActivate = jest.fn();
    const props = recordButtonA11y({ isRecording: false, enabled: true, onActivate });
    expect(props).toMatchObject({
      accessible: true,
      accessibilityRole: 'button',
      accessibilityLabel: 'Start recording',
      accessibilityState: { disabled: false },
      accessibilityActions: [{ name: 'activate' }],
    });
    props.onAccessibilityAction(action('activate'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('stops a take the same way', () => {
    const onActivate = jest.fn();
    const props = recordButtonA11y({ isRecording: true, enabled: true, onActivate });
    expect(props.accessibilityLabel).toBe('Stop recording');
    props.onAccessibilityAction(action('activate'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the gestures are off (camera not ready, a drag, the mic question)', () => {
    const onActivate = jest.fn();
    const props = recordButtonA11y({ isRecording: false, enabled: false, onActivate });
    expect(props.accessibilityState).toEqual({ disabled: true });
    props.onAccessibilityAction(action('activate'));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('ignores other actions', () => {
    const onActivate = jest.fn();
    recordButtonA11y({ isRecording: false, enabled: true, onActivate }).onAccessibilityAction(
      action('magicTap'),
    );
    expect(onActivate).not.toHaveBeenCalled();
  });
});
