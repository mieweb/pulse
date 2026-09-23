import { describe, expect, it } from '@jest/globals';

import { commitLabel, readBuildInfo, utcLabel, versionLabel } from './build-info';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const PV = 'dd03d8cf661fb4bbf24370bb5f0304ab1edd1d5a';

const ciConfig = {
  version: '2.1.0',
  ios: { buildNumber: '45' },
  android: { versionCode: 20145 },
  extra: {
    build: {
      commit: SHA,
      ci: true,
      dirty: false,
      builtAt: '2026-09-24T14:05:30.000Z',
      pulsevault: PV,
    },
  },
};

describe('readBuildInfo', () => {
  it('reads a CI build, with the build number for the platform', () => {
    const ios = readBuildInfo(ciConfig, 'ios');
    expect(ios).toEqual({
      version: '2.1.0',
      buildNumber: '45',
      commit: '0123456',
      ci: true,
      dirty: false,
      builtAt: new Date('2026-09-24T14:05:30.000Z'),
      pulsevault: 'dd03d8c',
    });
    expect(readBuildInfo(ciConfig, 'android').buildNumber).toBe('20145');
  });

  it('degrades to unknowns when the config has no build info', () => {
    expect(readBuildInfo({ version: '2.1.0' }, 'ios')).toEqual({
      version: '2.1.0',
      buildNumber: null,
      commit: null,
      ci: false,
      dirty: false,
      builtAt: null,
      pulsevault: null,
    });
    expect(readBuildInfo(null, 'ios').version).toBe('unknown');
  });

  it('ignores an unparseable build date', () => {
    const config = {
      ...ciConfig,
      extra: { build: { ...ciConfig.extra.build, builtAt: 'garbage' } },
    };
    expect(readBuildInfo(config, 'ios').builtAt).toBeNull();
  });
});

describe('labels', () => {
  const ci = readBuildInfo(ciConfig, 'ios');

  it('shows the build number only when there is one', () => {
    expect(versionLabel(ci)).toBe('2.1.0 (45)');
    expect(versionLabel({ ...ci, buildNumber: null })).toBe('2.1.0');
  });

  it('marks local and modified builds', () => {
    expect(commitLabel(ci)).toBe('0123456');
    expect(commitLabel({ ...ci, ci: false })).toBe('0123456 · local build');
    expect(commitLabel({ ...ci, ci: false, dirty: true })).toBe('0123456 · local build, modified');
    expect(commitLabel({ ...ci, commit: null })).toBe('unknown');
  });

  it('formats the build date in UTC to the minute', () => {
    expect(utcLabel(new Date('2026-09-24T14:05:30.000Z'))).toBe('2026-09-24 14:05 UTC');
  });
});
