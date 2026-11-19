import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectNpmPackages, collectPods, formatNotices, licenseText } from './release-notices.mjs';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-notices-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, contents: string | object) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

describe('collectNpmPackages', () => {
  it('follows dependencies the way Node resolves them, one entry per name and version', () => {
    write('embed/package.json', { name: 'embed', dependencies: { a: '*', b: '*' } });
    write('node_modules/a/package.json', {
      name: 'a',
      version: '1.0.0',
      license: 'MIT',
      repository: { url: 'git+https://github.com/x/a.git' },
      dependencies: { b: '^2' },
      optionalDependencies: { 'only-on-linux': '*' },
    });
    write('node_modules/a/LICENSE', 'A license');
    // a's own b@2 wins over the hoisted b@1 for a; embed gets b@1.
    write('node_modules/a/node_modules/b/package.json', {
      name: 'b',
      version: '2.0.0',
      license: 'ISC',
    });
    write('node_modules/b/package.json', {
      name: 'b',
      version: '1.0.0',
      licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }],
      dependencies: { gone: '*' },
    });
    write('node_modules/b/LICENSE.md', 'B license');
    write('node_modules/b/NOTICE', 'B notice');

    const { packages, missing } = collectNpmPackages([path.join(dir, 'embed')], dir);
    expect(packages.map((p) => `${p.name}@${p.version} ${p.license}`)).toEqual([
      'a@1.0.0 MIT',
      'b@1.0.0 MIT OR Apache-2.0',
      'b@2.0.0 ISC',
    ]);
    expect(packages[0].url).toBe('https://github.com/x/a.git');
    expect(packages[0].text).toBe('A license');
    expect(packages[1].text).toBe('B license\n\nB notice');
    expect(packages[2].text).toBeNull();
    // A missing optional dependency is another platform's build; a missing required one is a gap.
    expect(missing).toEqual(['gone (from b)']);
  });
});

describe('collectPods and licenseText', () => {
  it('lists only the pods that carry a license file', () => {
    write('Pods/hermes-engine/LICENSE', 'Hermes MIT');
    write('Pods/SSZipArchive/LICENSE.txt', 'SSZip MIT');
    write('Pods/Headers/Public/x.h', '');
    expect(collectPods(path.join(dir, 'Pods')).map((p) => [p.name, p.text])).toEqual([
      ['SSZipArchive', 'SSZip MIT'],
      ['hermes-engine', 'Hermes MIT'],
    ]);
    expect(collectPods(path.join(dir, 'none'))).toEqual([]);
    expect(licenseText(path.join(dir, 'Pods/Headers'))).toBeNull();
  });
});

describe('formatNotices', () => {
  it('writes every section, in order, the same way each time', () => {
    const input = {
      title: 'PulseKit 1.2.3: third-party notices',
      packages: [
        { name: 'a', version: '1.0.0', license: 'MIT', url: 'https://x/a', text: 'A ``` text' },
      ],
      pods: [{ name: 'hermes-engine', version: null, license: 'see text', url: null, text: 'H' }],
      native: [
        { name: 'libavif', license: 'BSD-2-Clause', url: 'https://l' },
        { name: 'SDWebImage', license: 'MIT', url: 'https://s' },
      ],
    };
    const text = formatNotices(input);
    expect(formatNotices(input)).toBe(text);
    expect(text.startsWith('# PulseKit 1.2.3: third-party notices\n')).toBe(true);
    expect(text).toContain(
      '## npm packages (1)\n\n### a 1.0.0\n\nLicense: MIT  \nSource: https://x/a\n',
    );
    // The fence is longer than any backtick run in the text, so the text can't end it.
    expect(text).toContain('````text\nA ``` text\n````');
    expect(text.indexOf('### SDWebImage')).toBeLessThan(text.indexOf('### libavif'));
    expect(text.endsWith('Source: https://l\n')).toBe(true);
  });
});
