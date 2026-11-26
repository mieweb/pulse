import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { useEditorBack } from './use-editor-back';

let mockFocused = true;
let mockCleanup: (() => void) | undefined;
let mockListener: (() => boolean) | undefined;
const mockRemove = jest.fn(() => {
  mockListener = undefined;
});
const mockSubscribe = jest.fn((_event: string, listener: () => boolean) => {
  mockListener = listener;
  return { remove: mockRemove };
});
jest.mock('react', () => ({ useCallback: (callback: unknown) => callback }));
jest.mock('react-native', () => ({
  BackHandler: {
    addEventListener: (event: string, listener: () => boolean) => mockSubscribe(event, listener),
  },
}));
jest.mock('@/core/navigation/focus', () => ({
  useScreenFocusEffect: (effect: () => (() => void) | undefined) => {
    mockCleanup?.();
    mockCleanup = mockFocused ? effect() : undefined;
  },
}));

const setCropping = jest.fn<(value: null) => void>();
const setTyping = jest.fn<(value: null) => void>();
const setTools = jest.fn<(value: 'clip') => void>();
const setMode = jest.fn<(value: 'main') => void>();
const idle = {
  busy: false,
  cropping: false,
  typing: false,
  tools: 'clip' as const,
  mode: 'main' as const,
  setCropping,
  setTyping,
  setTools,
  setMode,
};
function render(state: Partial<Parameters<typeof useEditorBack>[0]> = {}) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Controlled native event/focus harness.
  useEditorBack({ ...idle, ...state });
}
beforeEach(() => {
  mockFocused = true;
  jest.clearAllMocks();
});
afterEach(() => {
  mockCleanup?.();
  mockCleanup = undefined;
});

describe('editor Android Back', () => {
  it('leaves ordinary main-mode Back to the navigation stack', () => {
    render();
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(mockListener).toBeUndefined();
  });

  it('keeps Back consumed when a toolbar interaction returns to main during a cut', () => {
    render({ busy: true, mode: 'captions' });
    expect(mockListener?.()).toBe(true);
    render({ busy: true, mode: 'edit' });
    expect(mockListener?.()).toBe(true);
    render({ busy: true, mode: 'main' });
    expect(mockSubscribe).toHaveBeenLastCalledWith('hardwareBackPress', expect.any(Function));
    expect(mockListener?.()).toBe(true);
    expect(setCropping).not.toHaveBeenCalled();
    expect(setTyping).not.toHaveBeenCalled();
    expect(setTools).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();

    render();
    expect(mockListener).toBeUndefined();
    expect(mockRemove).toHaveBeenCalledTimes(3);
  });

  it('blocks dismissing an active tool while its commit is busy', () => {
    render({ busy: true, cropping: true, typing: true, tools: 'speed', mode: 'edit' });
    expect(mockListener?.()).toBe(true);
    expect(setCropping).not.toHaveBeenCalled();
    expect(setTyping).not.toHaveBeenCalled();
    expect(setTools).not.toHaveBeenCalled();
    expect(setMode).not.toHaveBeenCalled();
  });

  it.each([
    {
      state: { cropping: true, typing: true, tools: 'speed', mode: 'edit' },
      action: setCropping,
      value: null,
    },
    { state: { typing: true, tools: 'speed', mode: 'edit' }, action: setTyping, value: null },
    { state: { tools: 'speed', mode: 'edit' }, action: setTools, value: 'clip' },
    { state: { mode: 'captions' }, action: setMode, value: 'main' },
  ] satisfies {
    state: Partial<Parameters<typeof useEditorBack>[0]>;
    action: typeof setCropping | typeof setTyping | typeof setTools | typeof setMode;
    value: null | 'clip' | 'main';
  }[])('dismisses only the innermost active tool when idle: $state', ({ state, action, value }) => {
    render(state);
    expect(mockListener?.()).toBe(true);
    expect(action).toHaveBeenCalledWith(value);
    expect(
      [setCropping, setTyping, setTools, setMode].filter((fn) => fn.mock.calls.length),
    ).toEqual([action]);
  });

  it('releases the native subscription when the editor loses focus', () => {
    render({ busy: true });
    expect(mockListener).toBeDefined();
    mockFocused = false;
    render({ busy: true });
    expect(mockRemove).toHaveBeenCalledTimes(1);
    expect(mockListener).toBeUndefined();
  });
});
