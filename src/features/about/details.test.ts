import { describe, expect, it } from '@jest/globals';

import { readBuildInfo } from './build-info';
import { compatLabel, formatDetails, type ServerCompat } from './details';

const build = readBuildInfo(
  {
    version: '2.1.0',
    ios: { buildNumber: '45' },
    extra: {
      build: {
        commit: '0123456789abcdef',
        ci: true,
        builtAt: '2026-09-24T14:05:00.000Z',
        pulsevault: 'dd03d8cf661fb4bb',
      },
    },
  },
  'ios',
);
const device = { os: 'iOS', osVersion: '18.1', model: 'iPhone 15 Pro' };
const server = (host: string) => ({ server: `https://${host}/pulsevault`, host });

describe('compatLabel', () => {
  it('describes every status', () => {
    const labels = (
      [
        { ...server('a'), status: 'checking' },
        { ...server('a'), status: 'compatible', minVersion: 1, maxVersion: 1 },
        { ...server('a'), status: 'compatible', minVersion: 1, maxVersion: 2 },
        { ...server('a'), status: 'app-too-old' },
        { ...server('a'), status: 'app-too-new' },
        { ...server('a'), status: 'unreachable' },
      ] satisfies ServerCompat[]
    ).map(compatLabel);
    expect(labels).toEqual([
      'Checking…',
      'Compatible · protocol 1',
      'Compatible · protocol 1–2',
      'Needs a newer version of Pulse',
      'Server needs an update',
      "Couldn't reach it",
    ]);
  });
});

describe('formatDetails', () => {
  it('produces one block with everything the About page shows', () => {
    const text = formatDetails({
      build,
      device,
      protocol: 1,
      servers: [
        { ...server('vault.example.org'), status: 'compatible', minVersion: 1, maxVersion: 1 },
        { ...server('old.example.org'), status: 'app-too-new' },
      ],
    });
    expect(text).toBe(
      [
        'Pulse 2.1.0 (45)',
        'Commit: 0123456',
        'Built: 2026-09-24 14:05 UTC',
        'Built against PulseVault: dd03d8c',
        'Device: iPhone 15 Pro · iOS 18.1',
        'Upload protocol: v1',
        'Paired servers:',
        '  vault.example.org — Compatible · protocol 1',
        '  old.example.org — Server needs an update',
      ].join('\n'),
    );
  });

  it('says so when nothing is paired, and tolerates missing device details', () => {
    const text = formatDetails({
      build,
      device: { os: 'Android', osVersion: null, model: null },
      protocol: 1,
      servers: [],
    });
    expect(text).toContain('Device: Android');
    expect(text).toContain('Paired servers: none');
  });
});
