// @ts-check
// The size report each packaging run writes next to the zips: per xcframework, the download
// (zip), what it unpacks to, and the stripped iOS device binary, which is what an app ships.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Bytes under `root`: regular files' sizes, plus each symlink's own size (links aren't followed).
 * A file counts as itself. A missing path is 0.
 * @param {string} root
 */
export function treeSize(root) {
  let st;
  try {
    st = fs.lstatSync(root);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of fs.readdirSync(root)) total += treeSize(path.join(root, entry));
  return total;
}

/**
 * @typedef {object} SizeRow
 * @property {string} name          The xcframework (or other asset) name.
 * @property {number} zipBytes      The release zip.
 * @property {number} unpackedBytes The packaged folder.
 * @property {number | null} deviceBinaryBytes The stripped iOS device binary; null for non-code assets.
 */

/**
 * Rows sorted largest download first, with totals.
 * @param {SizeRow[]} rows
 */
export function buildSizeReport(rows) {
  const sorted = [...rows].sort((a, b) => b.zipBytes - a.zipBytes || (a.name < b.name ? -1 : 1));
  const totals = {
    zipBytes: sorted.reduce((s, r) => s + r.zipBytes, 0),
    unpackedBytes: sorted.reduce((s, r) => s + r.unpackedBytes, 0),
    deviceBinaryBytes: sorted.reduce((s, r) => s + (r.deviceBinaryBytes ?? 0), 0),
  };
  return { rows: sorted, totals };
}

/**
 * Bytes in MB (10^6) to one decimal, the unit App Store Connect reports sizes in.
 * @param {number} bytes
 */
export function formatMB(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/**
 * The report as a Markdown table, for the release notes and the CI summary.
 * @param {ReturnType<typeof buildSizeReport>} report
 * @param {{ title?: string }} [options]
 */
export function formatSizeReport(report, options = {}) {
  const lines = [
    `# ${options.title ?? 'PulseKit iOS size report'}`,
    '',
    '| Asset | Zip | Unpacked | iOS device binary |',
    '|---|---:|---:|---:|',
  ];
  for (const r of report.rows) {
    const bin = r.deviceBinaryBytes === null ? '–' : formatMB(r.deviceBinaryBytes);
    lines.push(`| ${r.name} | ${formatMB(r.zipBytes)} | ${formatMB(r.unpackedBytes)} | ${bin} |`);
  }
  const t = report.totals;
  lines.push(
    `| **Total** | **${formatMB(t.zipBytes)}** | **${formatMB(t.unpackedBytes)}** | **${formatMB(t.deviceBinaryBytes)}** |`,
  );
  return `${lines.join('\n')}\n`;
}
