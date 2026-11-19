import { describe, expect, it } from '@jest/globals';

// The embed scripts' libraries are .mjs (ESM). Jest runs CommonJS, so this import only works when
// jest.config.js sends .mjs through babel-jest too; without it: "SyntaxError: Unexpected token
// 'export'".
import { x } from './__fixtures__/probe.mjs';

describe('the .mjs transform', () => {
  it('loads an ES module library into a .ts test', () => {
    expect(x).toBe(1);
  });
});
