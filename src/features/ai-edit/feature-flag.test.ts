import { describe, expect, it } from '@jest/globals';

import { aiEditingEnabled } from './feature-flag';

describe('AI editing developer gate', () => {
  it('defaults on for development and off for ordinary release builds', () => {
    expect(aiEditingEnabled(true)).toBe(true);
    expect(aiEditingEnabled(false)).toBe(false);
    expect(aiEditingEnabled(false, { aiEditing: true })).toBe(false);
  });

  it('requires an explicit developer marker for an offline release build', () => {
    expect(aiEditingEnabled(false, { developerBuild: true })).toBe(true);
    expect(aiEditingEnabled(false, { developerBuild: false })).toBe(false);
  });

  it('can disable the experiment for every build type', () => {
    expect(aiEditingEnabled(true, { aiEditing: false })).toBe(false);
    expect(aiEditingEnabled(false, { developerBuild: true, aiEditing: false })).toBe(false);
  });
});
