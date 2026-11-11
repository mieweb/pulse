import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockStore = new Map<string, string>();
jest.mock('@/db/settings', () => ({
  getSetting: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setSetting: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
}));

/* eslint-disable import/first -- the mock above must be registered before this loads */
import {
  handledLinkOutcome,
  parseHandled,
  rememberHandledLink,
  withHandled,
} from './handled-links';
/* eslint-enable import/first */

beforeEach(() => mockStore.clear());

describe('handled links', () => {
  it('remembers what a link’s upload id came to, as a later launch reads it', async () => {
    expect(await handledLinkOutcome('art-1')).toBeNull();
    await rememberHandledLink('art-1', 'paired');
    await rememberHandledLink('art-2', 'refused');
    expect(await handledLinkOutcome('art-1')).toBe('paired');
    expect(await handledLinkOutcome('art-2')).toBe('refused');
    expect(await handledLinkOutcome('art-3')).toBeNull();
    // What a new process finds: the settings row, nothing in memory.
    expect(parseHandled([...mockStore.values()][0])).toEqual(['art-1', 'refused:art-2']);
  });

  it('keeps one outcome per link: the last one', async () => {
    await rememberHandledLink('art-1', 'refused');
    await rememberHandledLink('art-1', 'paired');
    expect(await handledLinkOutcome('art-1')).toBe('paired');
    expect(parseHandled([...mockStore.values()][0])).toEqual(['art-1']);
  });

  it('reads the ids an earlier build stored as paired', async () => {
    mockStore.set('pairing.handledLinks', JSON.stringify(['old-1', 'old-2']));
    expect(await handledLinkOutcome('old-2')).toBe('paired');
  });

  it('keeps every id when several are remembered at once', async () => {
    await Promise.all(['a', 'b', 'c'].map((id) => rememberHandledLink(id, 'paired')));
    expect(parseHandled([...mockStore.values()][0])).toEqual(['a', 'b', 'c']);
  });

  it('keeps the newest 200, and moves one remembered again to the end', () => {
    const many = Array.from({ length: 200 }, (_, i) => `id-${i}`);
    expect(withHandled(many, 'new')).toHaveLength(200);
    expect(withHandled(many, 'new')[0]).toBe('id-1');
    expect(withHandled(many, 'new')[199]).toBe('new');
    expect(withHandled(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
  });

  it('reads a damaged or missing list as empty', () => {
    for (const value of [null, undefined, '', 'not json', '{"a":1}', '7']) {
      expect(parseHandled(value)).toEqual([]);
    }
    expect(parseHandled('["a", 7, null, "b"]')).toEqual(['a', 'b']);
  });

  it('still remembers after a write that failed', async () => {
    const { setSetting } = jest.requireMock<{ setSetting: jest.Mock }>('@/db/settings');
    setSetting.mockImplementationOnce(async () => {
      throw new Error('disk full');
    });
    await expect(rememberHandledLink('lost', 'paired')).rejects.toThrow();
    await rememberHandledLink('kept', 'paired');
    expect(await handledLinkOutcome('kept')).toBe('paired');
  });
});
