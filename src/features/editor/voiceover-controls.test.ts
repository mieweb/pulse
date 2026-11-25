import { describe, expect, it, jest } from '@jest/globals';

import { voiceoverRecordingActions } from './voiceover-controls';
import type { VoiceoverPhase } from './voiceover-session';

jest.mock('react-native', () => ({ StyleSheet: { create: <T>(styles: T) => styles } }));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/hooks/use-theme', () => ({ useTheme: () => ({}) }));
jest.mock('@/constants/theme', () => ({ Accent: '#f00' }));

function controls() {
  const press = jest.fn<() => undefined>();
  const release = jest.fn<() => undefined>();
  const owner = voiceoverRecordingActions();
  const render = (phase: VoiceoverPhase, undoBusy = false) =>
    owner.forVoiceover({ phase, undoBusy, press, release });
  return { press, release, resetHold: owner.resetHold, render };
}

describe('voiceover recording controls', () => {
  it('offers standard Start activation without touch-down/up recording handlers', () => {
    const { render, press, release } = controls();
    const { toggle, hold } = render('ready');
    expect(toggle).toMatchObject({
      disabled: false,
      accessibilityRole: 'button',
      accessibilityLabel: 'Start recording voiceover',
      accessibilityState: { disabled: false, busy: false },
    });
    expect(toggle).not.toHaveProperty('onPressIn');
    expect(toggle).not.toHaveProperty('onPressOut');
    expect(toggle).not.toHaveProperty('onTouchEnd');
    expect(hold).toMatchObject({
      accessible: false,
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
    toggle.onPress();
    expect(press).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it.each(['starting', 'recording'] as const)('keeps Stop reachable during %s', (phase) => {
    const { render, press, release } = controls();
    const { toggle, hold } = render(phase, true);
    expect(toggle).toMatchObject({
      disabled: false,
      accessibilityLabel: 'Stop recording voiceover',
      accessibilityState: { disabled: false, busy: false },
    });
    expect(hold.disabled).toBe(false);
    toggle.onPress();
    expect(release).toHaveBeenCalledTimes(1);
    expect(press).not.toHaveBeenCalled();
  });

  it.each(['preparing', 'saving', 'failed'] as const)('blocks Start during %s', (phase) => {
    const { render, press, release } = controls();
    const { toggle, hold } = render(phase);
    expect(toggle.disabled).toBe(true);
    expect(toggle.accessibilityState.disabled).toBe(true);
    expect(toggle.accessibilityState.busy).toBe(phase !== 'failed');
    expect(hold.disabled).toBe(true);
    toggle.onPress();
    hold.onPressIn();
    hold.onTouchEnd();
    expect(press).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('blocks both start methods while Undo is in progress', () => {
    const { render, press } = controls();
    const { toggle, hold } = render('ready', true);
    expect(toggle.accessibilityState.disabled).toBe(true);
    expect(hold.disabled).toBe(true);
    toggle.onPress();
    hold.onPressIn();
    expect(press).not.toHaveBeenCalled();
  });

  it('saves a hold on actual release once, with no delayed Pressability callback', () => {
    const { render, press, release } = controls();
    const first = render('ready').hold;
    first.onPressIn();
    expect(render('recording').hold.disabled).toBe(false);
    first.onTouchEnd();
    first.onTouchCancel();
    expect(release).toHaveBeenCalledTimes(1);
    const second = render('ready').hold;
    second.onPressIn();
    expect(press).toHaveBeenCalledTimes(2);
    // An old onPressOut may arrive after a new take starts; neither take registers it.
    expect(first).not.toHaveProperty('onPressOut');
    expect(second).not.toHaveProperty('onPressOut');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not let raw hold-release callbacks stop a recording started with Start', () => {
    const { render, press, release } = controls();
    const ready = render('ready');
    ready.toggle.onPress();
    ready.hold.onTouchEnd();
    ready.hold.onTouchCancel();
    const recording = render('recording');
    recording.hold.onPressIn();
    recording.hold.onTouchEnd();
    expect(press).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    recording.toggle.onPress();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('lets Start replace interrupted hold ownership before a late raw release', () => {
    const { render, press, release } = controls();
    const old = render('ready').hold;
    old.onPressIn();
    render('failed');
    render('ready').toggle.onPress();
    old.onTouchCancel();
    expect(release).not.toHaveBeenCalled();
    expect(press).toHaveBeenCalledTimes(2);
  });

  it('does not let interrupted hold ownership block a new hold after Retry', () => {
    const { render, press } = controls();
    render('ready').hold.onPressIn();
    render('failed');
    render('ready').hold.onPressIn();
    expect(press).toHaveBeenCalledTimes(2);
  });

  it('clears an interrupted hold even when its view never sends touch-cancel', () => {
    const { render, resetHold, press, release } = controls();
    const old = render('ready').hold;
    old.onPressIn();
    resetHold();
    old.onTouchEnd();
    expect(release).not.toHaveBeenCalled();
    const next = render('ready').hold;
    next.onPressIn();
    next.onTouchEnd();
    expect(press).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('lets Stop finish a physical hold without saving again when the finger lifts', () => {
    const { render, release } = controls();
    const hold = render('ready').hold;
    hold.onPressIn();
    render('starting').toggle.onPress();
    hold.onTouchEnd();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
