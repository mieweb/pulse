import { describe, expect, it } from '@jest/globals';

import { CONTEXT_KEY_MAX, contextKey } from './context-key';
import { isPulseError } from './index';

function thrown(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error('expected a throw');
}

function expectInvalid(f: () => unknown): void {
  const e = thrown(f);
  expect(isPulseError(e)).toBe(true);
  expect(e).toBeInstanceOf(Error);
  expect(e).toMatchObject({ name: 'PulseError', code: 'invalid_options', recoverable: false });
}

describe('contextKey', () => {
  it('joins kind and id with a colon', () => {
    expect(contextKey('ticket', '64f1c0ffee00000000000001')).toBe(
      'ticket:64f1c0ffee00000000000001',
    );
    expect(contextKey('clock', 'abc123')).toBe('clock:abc123');
    expect(contextKey('library', 'user-1')).toBe('library:user-1');
  });

  it('accepts every kind and id character the contract allows', () => {
    expect(contextKey('clock-plan', 'team1:2026-11-18')).toBe('clock-plan:team1:2026-11-18');
    expect(contextKey('a.b_c-9', 'x.y_z-0:1')).toBe('a.b_c-9:x.y_z-0:1');
  });

  it('lowercases the id only', () => {
    expect(contextKey('ticket', '64F1C0FFEE')).toBe('ticket:64f1c0ffee');
    expect(contextKey('huddle', 'TeamA')).toBe('huddle:teama');
    expectInvalid(() => contextKey('Ticket', 'abc'));
  });

  it('allows exactly 128 characters and refuses 129', () => {
    const at = 'x'.repeat(CONTEXT_KEY_MAX - 'ticket:'.length);
    expect(CONTEXT_KEY_MAX).toBe(128);
    expect(contextKey('ticket', at)).toHaveLength(128);
    expectInvalid(() => contextKey('ticket', `${at}x`));
  });

  it('refuses an empty kind or id', () => {
    expectInvalid(() => contextKey('', 'abc'));
    expectInvalid(() => contextKey('ticket', ''));
  });

  it('refuses characters outside [a-z0-9._:-]', () => {
    for (const id of ['a b', 'a/b', 'a#b', 'a?b', 'é', 'İd', 'a\nb', 'a+b']) {
      expectInvalid(() => contextKey('ticket', id));
    }
    for (const kind of ['tick et', 'ticket:', 'a:b', 'tické', 'a/b']) {
      expectInvalid(() => contextKey(kind, 'abc'));
    }
  });

  it('refuses a non-ASCII id letter that lowercases to ASCII', () => {
    // KELVIN SIGN (U+212A) lowercases to 'k'.
    expect('\u212A'.toLowerCase()).toBe('k');
    expectInvalid(() => contextKey('ticket', 'ab\u212A'));
  });

  it('refuses values that are not strings (JS callers)', () => {
    expectInvalid(() => contextKey(undefined as unknown as string, 'abc'));
    expectInvalid(() => contextKey('ticket', 42 as unknown as string));
  });
});

describe('isPulseError', () => {
  it('needs the PulseError name, a code, a message and a callId', () => {
    const base = { name: 'PulseError', code: 'busy', message: 'x', callId: 'c-1' };
    expect(isPulseError(base)).toBe(true);
    expect(isPulseError(Object.assign(new Error('x'), base))).toBe(true);
    expect(isPulseError(new Error('x'))).toBe(false);
    expect(isPulseError({ ...base, name: 'Error' })).toBe(false);
    expect(isPulseError({ ...base, code: undefined })).toBe(false);
    expect(isPulseError({ ...base, callId: undefined })).toBe(false);
    expect(isPulseError(null)).toBe(false);
    expect(isPulseError('PulseError')).toBe(false);
  });
});
