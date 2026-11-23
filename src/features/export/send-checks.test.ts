import { describe, expect, it } from '@jest/globals';

import {
  checkSend,
  formatCap,
  NEEDS_CONNECTION,
  NEEDS_NAME,
  tooLargeText,
  uploadRulesOf,
  type UploadRules,
} from './send-checks';

const MB = 1024 * 1024;
const CAP = 500 * MB;

const rules = (over: Partial<UploadRules> = {}): UploadRules => ({
  ...uploadRulesOf({ id: 'ticket.video', version: 1 })!,
  ...over,
});

describe('uploadRulesOf', () => {
  it('reads the fields Pulse uses from a stored upload type', () => {
    expect(
      uploadRulesOf({
        id: 'clock.wrapup',
        version: 1,
        title: 'Wrap-up',
        prompt: ' Say what you finished today ',
        sendLabel: 'Clock out & send',
        requireName: true,
        requireOnline: true,
        confirmSend: true,
        maxBytes: CAP,
        meta: { x: 1 },
      }),
    ).toEqual({
      id: 'clock.wrapup',
      title: 'Wrap-up',
      prompt: 'Say what you finished today',
      sendLabel: 'Clock out & send',
      requireName: true,
      requireOnline: true,
      maxBytes: CAP,
    });
  });

  it('is null without an upload type', () => {
    expect(uploadRulesOf(null)).toBeNull();
    expect(uploadRulesOf(undefined)).toBeNull();
    expect(uploadRulesOf('ticket.video')).toBeNull();
    expect(uploadRulesOf([])).toBeNull();
  });

  it('reads a field of the wrong type as unset', () => {
    expect(
      uploadRulesOf({ id: 7, requireName: 'yes', requireOnline: 1, maxBytes: '500', prompt: '' }),
    ).toEqual({
      id: null,
      title: null,
      prompt: null,
      sendLabel: null,
      requireName: false,
      requireOnline: false,
      maxBytes: null,
    });
    expect(uploadRulesOf({ maxBytes: 0 })?.maxBytes).toBeNull();
    expect(uploadRulesOf({ maxBytes: Infinity })?.maxBytes).toBeNull();
  });
});

describe('checkSend', () => {
  it('changes nothing for a draft without a host upload type (the Pulse app)', () => {
    expect(checkSend({ rules: null, name: null, online: false, exportBytes: 9e9 })).toEqual({
      block: null,
      blockText: null,
      tooLarge: null,
    });
  });

  it('lets a type with no rules send', () => {
    expect(checkSend({ rules: rules(), name: null, online: false, exportBytes: 9e9 })).toEqual({
      block: null,
      blockText: null,
      tooLarge: null,
    });
  });

  describe('requireName', () => {
    const r = rules({ requireName: true });
    it('blocks until the draft has a name of its own', () => {
      expect(checkSend({ rules: r, name: null, online: true, exportBytes: 1 })).toMatchObject({
        block: 'name',
        blockText: NEEDS_NAME,
      });
      expect(checkSend({ rules: r, name: '   ', online: true, exportBytes: 1 }).block).toBe('name');
      expect(checkSend({ rules: r, name: 'Fix login', online: true, exportBytes: 1 }).block).toBe(
        null,
      );
    });

    it('does not hold back a library a newer Pulse migrated (it can’t be named; it still sends)', () => {
      const check = checkSend({
        rules: r,
        name: null,
        online: true,
        exportBytes: 1,
        editable: false,
      });
      expect(check).toMatchObject({ block: null, blockText: null });
      // Its other rules still hold.
      const offline = rules({ requireName: true, requireOnline: true });
      expect(
        checkSend({ rules: offline, name: null, online: false, exportBytes: 1, editable: false })
          .block,
      ).toBe('offline');
    });
  });

  describe('requireOnline', () => {
    const r = rules({ requireOnline: true });
    it('is disabled offline with "Needs a connection"', () => {
      expect(checkSend({ rules: r, name: null, online: false, exportBytes: 1 })).toMatchObject({
        block: 'offline',
        blockText: NEEDS_CONNECTION,
      });
    });

    it('is checked again at the tap: the network can drop after the render', () => {
      const atRender = checkSend({ rules: r, name: null, online: true, exportBytes: 1 });
      const atTap = checkSend({ rules: r, name: null, online: false, exportBytes: 1 });
      expect(atRender.block).toBeNull();
      expect(atTap.block).toBe('offline');
    });

    it('does not hold back a type that does not ask for it', () => {
      expect(checkSend({ rules: rules(), name: null, online: false, exportBytes: 1 }).block).toBe(
        null,
      );
    });

    it('names the missing name first when both are missing', () => {
      const both = rules({ requireName: true, requireOnline: true });
      expect(checkSend({ rules: both, name: null, online: false, exportBytes: 1 }).block).toBe(
        'name',
      );
      expect(checkSend({ rules: both, name: 'x', online: false, exportBytes: 1 }).block).toBe(
        'offline',
      );
    });
  });

  describe('maxBytes', () => {
    const r = rules({ maxBytes: CAP });
    it('warns over the cap, with the cap in the text, without blocking', () => {
      const check = checkSend({ rules: r, name: null, online: true, exportBytes: CAP + 1 });
      expect(check.block).toBeNull();
      expect(check.tooLarge).toEqual({ maxBytes: CAP, text: 'Too large to send (max 500 MB)' });
    });

    it('is quiet at or under the cap, and while the size is unknown', () => {
      expect(checkSend({ rules: r, name: null, online: true, exportBytes: CAP }).tooLarge).toBe(
        null,
      );
      expect(checkSend({ rules: r, name: null, online: true, exportBytes: null }).tooLarge).toBe(
        null,
      );
    });

    it('warns alongside a block', () => {
      const both = rules({ maxBytes: CAP, requireOnline: true });
      const check = checkSend({ rules: both, name: null, online: false, exportBytes: 2 * CAP });
      expect(check.block).toBe('offline');
      expect(check.tooLarge?.maxBytes).toBe(CAP);
    });
  });
});

describe('formatCap', () => {
  it('reads as the phone shows storage', () => {
    expect(formatCap(500 * MB)).toBe('500 MB');
    expect(formatCap(1024 * MB)).toBe('1 GB');
    expect(formatCap(1536 * MB)).toBe('1.5 GB');
    expect(formatCap(300 * 1024)).toBe('300 KB');
    expect(tooLargeText(2 * 1024 * MB)).toBe('Too large to send (max 2 GB)');
  });
});
