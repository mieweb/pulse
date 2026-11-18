// Symlinks a shipped xcframework must not contain. expo-brownfield's hermesvm.xcframework had
// absolute links into the producer's Pods folder; they break on every other machine and survive
// zipping as dangling links. A relative link that climbs out of the tree breaks the same way.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} UnsafeSymlink
 * @property {string} path    The link, relative to the scanned root.
 * @property {string} target  What it points to, as stored.
 * @property {'absolute' | 'escapes'} reason
 */

/**
 * Walks `root` (without following links) and returns every symlink that is absolute or resolves
 * outside `root`, sorted by path. A missing root has none.
 * @param {string} root
 * @returns {UnsafeSymlink[]}
 */
export function findUnsafeSymlinks(root) {
  /** @type {UnsafeSymlink[]} */
  const found = [];
  const top = path.resolve(root);
  if (!fs.existsSync(top)) return found;

  const visit = (/** @type {string} */ dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        const rel = path.relative(top, full);
        if (path.isAbsolute(target)) {
          found.push({ path: rel, target, reason: 'absolute' });
        } else {
          const resolved = path.relative(top, path.resolve(path.dirname(full), target));
          if (
            resolved === '..' ||
            resolved.startsWith(`..${path.sep}`) ||
            path.isAbsolute(resolved)
          ) {
            found.push({ path: rel, target, reason: 'escapes' });
          }
        }
      } else if (entry.isDirectory()) {
        visit(full);
      }
    }
  };
  if (fs.lstatSync(top).isDirectory()) visit(top);
  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * One line per unsafe link, for the error the packaging run stops with.
 * @param {string} label  What was scanned (an xcframework name).
 * @param {UnsafeSymlink[]} links
 */
export function describeUnsafeSymlinks(label, links) {
  return links.map((l) => `${label}/${l.path} -> ${l.target} (${l.reason})`);
}
