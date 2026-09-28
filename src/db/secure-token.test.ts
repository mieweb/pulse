import { describe, expect, it, jest } from '@jest/globals';

import { deleteSavedLink, getSavedLink, setSavedLink } from './secure-token';

// jest hoists this mock above the imports; `mock`-prefixed names may be used inside it.
const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mockStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    mockStore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    mockStore.delete(key);
  },
}));

describe('saved links', () => {
  it('round-trips a view link and a plain link, which has no expiry', async () => {
    await setSavedLink('view', { url: 'https://v/view?token=ro', expiresAt: 1_800_000_000_000 });
    await setSavedLink('plain', { url: 'https://v/artifacts/a', expiresAt: null });

    expect(await getSavedLink('view')).toEqual({
      url: 'https://v/view?token=ro',
      expiresAt: 1_800_000_000_000,
    });
    expect(await getSavedLink('plain')).toEqual({ url: 'https://v/artifacts/a', expiresAt: null });

    await deleteSavedLink('plain');
    expect(await getSavedLink('plain')).toBeNull();
  });

  it('reads a view link saved before plain links existed (same key)', async () => {
    mockStore.set('upload.view.old', JSON.stringify({ url: 'https://v/old', expiresAt: 5 }));
    expect(await getSavedLink('old')).toEqual({ url: 'https://v/old', expiresAt: 5 });
  });

  it('ignores anything it can’t read as a link', async () => {
    mockStore.set('upload.view.a', 'not json');
    mockStore.set('upload.view.b', JSON.stringify({ url: 'https://v/b' }));
    mockStore.set('upload.view.c', JSON.stringify({ url: 3, expiresAt: null }));
    mockStore.set('upload.view.d', JSON.stringify({ url: 'https://v/d', expiresAt: 'soon' }));
    for (const id of ['a', 'b', 'c', 'd', 'missing']) expect(await getSavedLink(id)).toBeNull();
  });
});
