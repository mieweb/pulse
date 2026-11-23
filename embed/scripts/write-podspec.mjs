#!/usr/bin/env node
// Writes cordova-plugin-pulse's PulseKit.podspec for a PulseKit release: an :http source on the
// release's all-in-one xcframeworks zip, with its :sha256 from the release's SHA256SUMS. With
// --placeholder it writes the committed 0.0.0-dev file instead. The template is
// lib/release-podspec.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  placeholderPodspec,
  renderPodspec,
  xcframeworksZipSha256,
} from './lib/release-podspec.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT = 'embed/packages/cordova-plugin-pulse/PulseKit.podspec';

const HELP = `Usage: node embed/scripts/write-podspec.mjs --sums <SHA256SUMS> --version <v> --base-url <url>
       node embed/scripts/write-podspec.mjs --placeholder

Options:
  --sums <file>      The release's SHA256SUMS (package-ios.mjs's <out>/release/SHA256SUMS).
  --version <v>      The release version (from the pulsekit-v<version> tag).
  --base-url <url>   Where the release's assets download from
                     (https://github.com/<owner>/<repo>/releases/download/<tag>).
  --placeholder      Write the committed placeholder (0.0.0-dev, zero checksum).
  --out <file>       Where to write (default: ${DEFAULT_OUT}, relative to the repo).
  --check            Write nothing; fail if --out differs from what would be written.
  -h, --help         Show this help.
`;

function main() {
  const { values } = parseArgs({
    options: {
      sums: { type: 'string' },
      version: { type: 'string' },
      'base-url': { type: 'string' },
      placeholder: { type: 'boolean', default: false },
      out: { type: 'string' },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  let text;
  if (values.placeholder) {
    text = placeholderPodspec();
  } else {
    if (!values.sums || !values.version || !values['base-url']) {
      throw new Error('--sums, --version and --base-url are required (or --placeholder)');
    }
    text = renderPodspec({
      version: values.version,
      baseUrl: values['base-url'],
      sha256: xcframeworksZipSha256(fs.readFileSync(values.sums, 'utf8')),
    });
  }
  const out = values.out ? path.resolve(values.out) : path.join(repoRoot, DEFAULT_OUT);
  if (values.check) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    if (current !== text) throw new Error(`${out} is not what the generator writes`);
    console.log(`${out} is up to date`);
    return;
  }
  fs.writeFileSync(out, text);
  console.log(`wrote ${out}`);
}

try {
  main();
} catch (err) {
  console.error(`write-podspec: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
