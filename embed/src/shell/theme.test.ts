import { describe, expect, it } from '@jest/globals';
import type { OpenRequest } from '@mieweb/pulse-embed';

import { themeOf, themeOverrides } from './theme';

const edit: OpenRequest = { entry: 'edit', draftId: 'd1' };

describe('the theme bridge', () => {
  it('maps a host theme onto PulseCore’s', () => {
    expect(
      themeOverrides({
        appearance: 'dark',
        accent: '#0055AA',
        destructive: '#cc0000',
        buttonRadius: 6,
      }),
    ).toEqual({ mode: 'dark', accent: '#0055AA', destructive: '#cc0000', buttonRadius: 6 });
  });

  it('follows the OS without an appearance, and leaves out what it can’t use', () => {
    expect(themeOverrides(undefined)).toEqual({ mode: 'system' });
    expect(
      themeOverrides({
        appearance: 'sepia',
        accent: 'blue',
        buttonRadius: -1,
      } as unknown as Parameters<typeof themeOverrides>[0]),
    ).toEqual({ mode: 'system' });
  });

  it('takes the request’s theme over the configured one, whole', () => {
    const configured = { theme: { accent: '#111111', buttonRadius: 4 } };
    expect(themeOf({ ...edit, theme: { accent: '#222222' } }, configured)).toEqual({
      accent: '#222222',
    });
    expect(themeOf(edit, configured)).toEqual(configured.theme);
    expect(themeOf(edit, {})).toBeUndefined();
  });
});
