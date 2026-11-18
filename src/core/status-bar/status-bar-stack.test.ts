import { describe, expect, it } from '@jest/globals';

import { createStatusBarStack } from './status-bar-stack';

describe('createStatusBarStack', () => {
  it('is empty until a style is pushed', () => {
    expect(createStatusBarStack().top()).toBeNull();
  });

  it('the newest push wins', () => {
    const stack = createStatusBarStack();
    stack.push('dark');
    expect(stack.top()).toBe('dark');
    stack.push('light');
    expect(stack.top()).toBe('light');
  });

  it('popping the top restores the style before it, down to empty', () => {
    const stack = createStatusBarStack();
    const first = stack.push('dark');
    const second = stack.push('light');
    stack.pop(second);
    expect(stack.top()).toBe('dark');
    stack.pop(first);
    expect(stack.top()).toBeNull();
  });

  it('popping an entry below the top leaves the top in place', () => {
    const stack = createStatusBarStack();
    const below = stack.push('light');
    stack.push('dark');
    stack.pop(below);
    expect(stack.top()).toBe('dark');
  });

  it('two pushes of the same style are separate entries', () => {
    const stack = createStatusBarStack();
    stack.push('dark');
    const a = stack.push('light');
    const b = stack.push('light');
    stack.pop(b);
    expect(stack.top()).toBe('light');
    stack.pop(a);
    expect(stack.top()).toBe('dark');
  });

  it('popping an entry twice does nothing the second time', () => {
    const stack = createStatusBarStack();
    stack.push('dark');
    const light = stack.push('light');
    stack.pop(light);
    stack.pop(light);
    expect(stack.top()).toBe('dark');
  });

  it('a pushed-again style goes back on top (a screen focused again)', () => {
    const stack = createStatusBarStack();
    const light = stack.push('light');
    stack.push('dark');
    stack.pop(light);
    stack.push('light');
    expect(stack.top()).toBe('light');
  });

  it('tells subscribers about each change until they unsubscribe', () => {
    const stack = createStatusBarStack();
    const seen: (string | null)[] = [];
    const unsubscribe = stack.subscribe(() => seen.push(stack.top()));
    const entry = stack.push('light');
    stack.pop(entry);
    stack.pop(entry); // already gone: no change, no call
    unsubscribe();
    stack.push('dark');
    expect(seen).toEqual(['light', null]);
  });
});
