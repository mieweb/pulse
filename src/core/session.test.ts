import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { onSessionReset, resetSession } from './session';

const registered: (() => void)[] = [];
function register(reset: () => void): () => void {
  const off = onSessionReset(reset);
  registered.push(off);
  return off;
}

afterEach(() => {
  registered.splice(0).forEach((off) => off());
  jest.restoreAllMocks();
});

describe('resetSession', () => {
  it('runs every registered reset, in registration order', () => {
    const calls: string[] = [];
    register(() => calls.push('tips'));
    register(() => calls.push('queue'));
    register(() => calls.push('recorders'));
    resetSession();
    expect(calls).toEqual(['tips', 'queue', 'recorders']);
  });

  it('runs on every call, not once', () => {
    const reset = jest.fn();
    register(reset);
    resetSession();
    resetSession();
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it('skips a reset once it is unregistered', () => {
    const kept = jest.fn();
    const dropped = jest.fn();
    register(kept);
    const off = register(dropped);
    off();
    resetSession();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('a throwing reset is logged and the others still run', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const before = jest.fn();
    const after = jest.fn();
    register(before);
    register(() => {
      throw new Error('boom');
    });
    register(after);
    resetSession();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does nothing with nothing registered', () => {
    expect(() => resetSession()).not.toThrow();
  });
});
