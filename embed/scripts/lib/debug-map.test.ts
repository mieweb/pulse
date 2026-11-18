import { describe, expect, it } from '@jest/globals';

import { hasDebugMap } from './debug-map.mjs';

// `nm -ap` output from a tiny binary linked from `clang -g -c a.c` (debug map) and from one built
// without -g, captured on macOS.
const withMap = `0000000000000000 - 01 0000    SO
0000000000000000 - 00 0000    SO /private/tmp/pr1c-nm/
0000000000000000 - 00 0000    SO a.c
000000006afde7b5 - 00 0001   OSO /private/tmp/pr1c-nm/a.o
0000000100000328 - 01 0000 BNSYM
0000000100000328 - 01 0000   FUN _f
0000000100000000 T __mh_execute_header
0000000100000328 T _f
0000000100000340 T _main
`;
const withoutMap = `0000000100000000 T __mh_execute_header
0000000100000328 T _f
0000000100000330 T _main
`;

describe('hasDebugMap', () => {
  it('finds the OSO stabs dsymutil reads', () => {
    expect(hasDebugMap(withMap)).toBe(true);
  });

  it('finds them in one architecture of a fat binary', () => {
    expect(
      hasDebugMap(
        `\nbin (for architecture x86_64):\n${withoutMap}\nbin (for architecture arm64):\n${withMap}`,
      ),
    ).toBe(true);
  });

  it('has none in a release or stripped binary, or in an empty listing', () => {
    expect(hasDebugMap(withoutMap)).toBe(false);
    expect(hasDebugMap('')).toBe(false);
    // A symbol that merely contains "OSO" is not a stab.
    expect(hasDebugMap('0000000100000328 T _OSO_handler\n')).toBe(false);
  });
});
