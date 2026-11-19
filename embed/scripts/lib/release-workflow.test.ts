import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

// Text checks on the release workflow: it publishes with provenance, so what it runs must not move
// under it, and a failing command must fail its step.
const repoRoot = path.resolve(__dirname, '../../..');
const workflow = fs.readFileSync(
  path.join(repoRoot, '.github/workflows/release-embed.yml'),
  'utf8',
);
const lines = workflow.split('\n');

describe('release-embed.yml', () => {
  it('runs every step in bash, so pipefail is on', () => {
    expect(workflow).toMatch(/^defaults:\n {2}run:\n {4}shell: bash$/m);
    expect(lines.filter((l) => /^\s+shell:/.test(l) && !/shell: bash\s*$/.test(l))).toEqual([]);
  });

  it('pins every action to a commit SHA, with the exact version it is in a comment', () => {
    const uses = lines.filter((l) => /^\s*(- )?uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    const unpinned = uses.filter(
      (l) => !/uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(l),
    );
    expect(unpinned).toEqual([]);
  });

  it('pins the checked-out mieweb/actions to a commit SHA', () => {
    expect(workflow).toMatch(/repository: mieweb\/actions\n\s+ref: [0-9a-f]{40} #/);
  });

  it('installs an exact npm version that has trusted publishing (>= 11.5.1)', () => {
    const installs = [...workflow.matchAll(/npm install -g npm@(\S+)/g)].map((m) => m[1]);
    expect(installs).toHaveLength(1);
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(installs[0]);
    expect(match).not.toBeNull();
    const [major, minor, patch] = match!.slice(1).map(Number);
    expect(major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)))).toBe(true);
  });

  it('starts only on pulsekit-v tags, dispatch and workflow_call, never on pull requests', () => {
    const on = /^on:\n((?: {2}.*\n|\n)*)/m.exec(workflow);
    expect(on).not.toBeNull();
    const triggers = on![1]
      .split('\n')
      .filter((l) => /^ {2}\w/.test(l))
      .map((l) => l.trim().replace(/:.*$/, ''));
    expect(triggers).toEqual(['push', 'workflow_dispatch', 'workflow_call']);
    expect(on![1]).toMatch(/tags:\n\s+- 'pulsekit-v\*'/);
    expect(on![1]).not.toMatch(/branches/);
  });
});
