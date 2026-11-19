import { describe, expect, it } from '@jest/globals';

import { holdsCamera, releaseCamera, takeCamera } from './camera-holder';

describe('which recorder holds the camera', () => {
  it('is the one whose camera mounted last', () => {
    const below = {};
    const above = {};
    takeCamera(below);
    expect(holdsCamera(below)).toBe(true);
    takeCamera(above);
    expect(holdsCamera(below)).toBe(false);
    expect(holdsCamera(above)).toBe(true);
  });

  it('is nobody once the recorder on top unmounts: the one below still has to bind again', () => {
    const below = {};
    const above = {};
    takeCamera(below);
    takeCamera(above);
    releaseCamera(above);
    expect(holdsCamera(below)).toBe(false);
    expect(holdsCamera(above)).toBe(false);
    takeCamera(below);
    expect(holdsCamera(below)).toBe(true);
  });

  it('stays with the holder when another recorder that does not hold it unmounts', () => {
    const below = {};
    const gone = {};
    takeCamera(gone);
    takeCamera(below);
    releaseCamera(gone);
    expect(holdsCamera(below)).toBe(true);
  });
});
