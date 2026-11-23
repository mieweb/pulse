import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describeUnsafeSymlinks, findUnsafeSymlinks } from './symlinks.mjs';

// Links are made at run time: the repo never holds an absolute symlink.
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-symlinks-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A macOS-style versioned framework, the layout hermesvm's Catalyst slice has. */
function versionedFramework(dir: string, current: string) {
  fs.mkdirSync(path.join(dir, 'Versions', '1', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Versions', '1', 'hermesvm'), 'bin');
  fs.symlinkSync(current, path.join(dir, 'Versions', 'Current'));
  fs.symlinkSync('Versions/Current/hermesvm', path.join(dir, 'hermesvm'));
}

describe('findUnsafeSymlinks', () => {
  it('passes a framework whose links stay inside it', () => {
    versionedFramework(path.join(root, 'hermesvm.framework'), '1');
    expect(findUnsafeSymlinks(root)).toEqual([]);
  });

  it('reports absolute links, as expo-brownfield left them in hermesvm', () => {
    const pods = '/Users/someone/embed/ios/Pods/hermes-engine/hermesvm.framework/Versions/1';
    versionedFramework(path.join(root, 'macos-arm64_x86_64', 'hermesvm.framework'), pods);
    expect(findUnsafeSymlinks(root)).toEqual([
      {
        path: path.join('macos-arm64_x86_64', 'hermesvm.framework', 'Versions', 'Current'),
        target: pods,
        reason: 'absolute',
      },
    ]);
  });

  it('reports relative links that climb out of the tree', () => {
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    fs.symlinkSync('../../../outside', path.join(root, 'a', 'b', 'up'));
    fs.symlinkSync('../sibling', path.join(root, 'a', 'b', 'ok'));
    expect(findUnsafeSymlinks(root)).toEqual([
      { path: path.join('a', 'b', 'up'), target: '../../../outside', reason: 'escapes' },
    ]);
  });

  it('does not follow a linked folder', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-elsewhere-'));
    try {
      fs.symlinkSync('/etc', path.join(elsewhere, 'abs'));
      fs.symlinkSync(elsewhere, path.join(root, 'dir'));
      const found = findUnsafeSymlinks(root);
      expect(found.map((l) => l.path)).toEqual(['dir']);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('sorts by path and has none for a missing root', () => {
    fs.mkdirSync(path.join(root, 'z'));
    fs.symlinkSync('/z', path.join(root, 'z', 'l'));
    fs.symlinkSync('/a', path.join(root, 'a'));
    expect(findUnsafeSymlinks(root).map((l) => l.path)).toEqual(['a', path.join('z', 'l')]);
    expect(findUnsafeSymlinks(path.join(root, 'missing'))).toEqual([]);
  });

  it('describes each link for the error message', () => {
    expect(
      describeUnsafeSymlinks('hermesvm.xcframework', [
        { path: 'x', target: '/y', reason: 'absolute' },
      ]),
    ).toEqual(['hermesvm.xcframework/x -> /y (absolute)']);
  });
});
