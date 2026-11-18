import { describe, expect, it } from '@jest/globals';

import { createFocusController } from './focus';

/** A focus effect that logs each run and each cleanup. */
const tracked = (name = 'fx') => {
  const log: string[] = [];
  const effect = () => {
    log.push(`run ${name}`);
    return () => {
      log.push(`cleanup ${name}`);
    };
  };
  return { log, effect };
};

describe('createFocusController', () => {
  it('runs the effect when the screen gains focus, not before', () => {
    const c = createFocusController();
    const { log, effect } = tracked();
    c.setEffect(effect);
    expect(log).toEqual([]);
    c.setFocused(true);
    expect(log).toEqual(['run fx']);
  });

  it('runs at once when the effect arrives on a focused screen', () => {
    const c = createFocusController();
    const { log, effect } = tracked();
    c.setFocused(true);
    c.setEffect(effect);
    expect(log).toEqual(['run fx']);
  });

  it('runs the cleanup on blur, and the effect again on the next focus', () => {
    const c = createFocusController();
    const { log, effect } = tracked();
    c.setEffect(effect);
    c.setFocused(true);
    c.setFocused(false);
    expect(log).toEqual(['run fx', 'cleanup fx']);
    c.setFocused(true);
    expect(log).toEqual(['run fx', 'cleanup fx', 'run fx']);
  });

  it('runs the cleanup on unmount while focused, and nothing after', () => {
    const c = createFocusController();
    const { log, effect } = tracked();
    c.setEffect(effect);
    c.setFocused(true);
    c.dispose();
    expect(log).toEqual(['run fx', 'cleanup fx']);
    c.setFocused(false);
    c.setFocused(true);
    expect(log).toEqual(['run fx', 'cleanup fx']);
  });

  it('does not clean up twice: unmount after blur runs nothing', () => {
    const c = createFocusController();
    const { log, effect } = tracked();
    c.setEffect(effect);
    c.setFocused(true);
    c.setFocused(false);
    c.dispose();
    expect(log).toEqual(['run fx', 'cleanup fx']);
  });

  it('never runs twice for one focus', () => {
    const c = createFocusController();
    const { log, effect } = tracked();
    c.setEffect(effect);
    c.setFocused(true);
    c.setFocused(true);
    c.setEffect(effect);
    expect(log).toEqual(['run fx']);
  });

  it('a new effect while focused cleans up the old one and runs the new one', () => {
    const c = createFocusController();
    const a = tracked('a');
    const b = tracked('b');
    const log = () => [...a.log, ...b.log];
    c.setFocused(true);
    c.setEffect(a.effect);
    c.setEffect(b.effect);
    expect(a.log).toEqual(['run a', 'cleanup a']);
    expect(b.log).toEqual(['run b']);
    // While blurred, a new effect waits for focus.
    c.setFocused(false);
    c.setEffect(a.effect);
    expect(log()).toEqual(['run a', 'cleanup a', 'run b', 'cleanup b']);
    c.setFocused(true);
    expect(a.log).toEqual(['run a', 'cleanup a', 'run a']);
  });

  it('accepts an effect with no cleanup', () => {
    const c = createFocusController();
    let runs = 0;
    c.setEffect(() => {
      runs += 1;
    });
    c.setFocused(true);
    c.setFocused(false);
    c.setFocused(true);
    c.dispose();
    expect(runs).toBe(2);
  });

  it('works again after dispose when an effect is set (a remount in strict mode)', () => {
    const c = createFocusController();
    const { log, effect } = tracked();
    c.setEffect(effect);
    c.setFocused(true);
    c.dispose();
    c.setEffect(effect);
    expect(log).toEqual(['run fx', 'cleanup fx', 'run fx']);
  });
});
