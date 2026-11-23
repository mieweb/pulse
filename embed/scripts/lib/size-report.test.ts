import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSizeReport, formatMB, formatSizeReport, treeSize } from './size-report.mjs';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-size-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('treeSize', () => {
  it('adds up files in nested folders, a symlink as itself, not its target', () => {
    fs.mkdirSync(path.join(dir, 'X.framework', 'Headers'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'X.framework', 'X'), Buffer.alloc(1000));
    fs.writeFileSync(path.join(dir, 'X.framework', 'Headers', 'X.h'), Buffer.alloc(24));
    const big = path.join(os.tmpdir(), `pk-size-big-${process.pid}`);
    fs.writeFileSync(big, Buffer.alloc(50_000));
    try {
      fs.symlinkSync(big, path.join(dir, 'link'));
      expect(treeSize(dir)).toBe(1024 + big.length);
    } finally {
      fs.rmSync(big, { force: true });
    }
  });

  it('is a file’s own size for a file, and 0 for a missing path', () => {
    fs.writeFileSync(path.join(dir, 'f'), Buffer.alloc(7));
    expect(treeSize(path.join(dir, 'f'))).toBe(7);
    expect(treeSize(path.join(dir, 'missing'))).toBe(0);
  });
});

describe('buildSizeReport', () => {
  const rows = [
    {
      name: 'hermesvm.xcframework',
      zipBytes: 9_000_000,
      unpackedBytes: 20_000_000,
      deviceBinaryBytes: 5_066_176,
    },
    {
      name: 'PulseKit.xcframework',
      zipBytes: 300_000_000,
      unpackedBytes: 801_000_000,
      deviceBinaryBytes: 40_000_000,
    },
    { name: 'dSYMs', zipBytes: 9_000_000, unpackedBytes: 90_000_000, deviceBinaryBytes: null },
  ];

  it('puts the largest download first (ties by name) and totals every column', () => {
    const report = buildSizeReport(rows);
    expect(report.rows.map((r) => r.name)).toEqual([
      'PulseKit.xcframework',
      'dSYMs',
      'hermesvm.xcframework',
    ]);
    expect(report.totals).toEqual({
      zipBytes: 318_000_000,
      unpackedBytes: 911_000_000,
      deviceBinaryBytes: 45_066_176,
    });
  });

  it('formats a Markdown table in MB, with a dash where there is no binary', () => {
    const md = formatSizeReport(buildSizeReport(rows), {
      title: 'PulseKit 1.0.0 (7) iOS size report',
    });
    expect(md).toBe(
      [
        '# PulseKit 1.0.0 (7) iOS size report',
        '',
        '| Asset | Zip | Unpacked | iOS device binary |',
        '|---|---:|---:|---:|',
        '| PulseKit.xcframework | 300.0 MB | 801.0 MB | 40.0 MB |',
        '| dSYMs | 9.0 MB | 90.0 MB | – |',
        '| hermesvm.xcframework | 9.0 MB | 20.0 MB | 5.1 MB |',
        '| **Total** | **318.0 MB** | **911.0 MB** | **45.1 MB** |',
        '',
      ].join('\n'),
    );
    expect(formatMB(0)).toBe('0.0 MB');
  });
});
