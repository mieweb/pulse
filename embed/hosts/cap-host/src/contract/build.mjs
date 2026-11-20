// Bundles the contract page into the host's web folder: www/contract/{index.html, contract.js}.
// That folder is generated (embed/hosts/.gitignore); run this before `npx cap sync ios`.
//
//   node embed/hosts/cap-host/src/contract/build.mjs [outDir]
//
// esbuild comes from the Pulse checkout's node_modules (the repo root), so nothing is installed
// in the host for it.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../../..');
const out = resolve(process.argv[2] ?? join(here, '../../www/contract'));
const esbuild = createRequire(join(repo, 'package.json'))('esbuild');

mkdirSync(out, { recursive: true });
await esbuild.build({
  entryPoints: [join(here, 'main.ts')],
  bundle: true,
  format: 'iife',
  target: 'safari16',
  outfile: join(out, 'contract.js'),
  logLevel: 'warning',
});
copyFileSync(join(here, 'index.html'), join(out, 'index.html'));
console.log(`contract page → ${out}`);
