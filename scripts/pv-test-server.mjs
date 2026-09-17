// Boots the pulsevault submodule's BUILT core on an ephemeral port for the
// app's cross-repo integration suite (src/features/upload/pv-integration.test.ts).
// Prints "PV_PORT=<port>" on stdout once listening; exits when stdin closes
// (so a killed jest run can't leak servers). Local storage in a temp dir that
// is deleted on exit.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const distUrl = new URL('../pulsevault-mieweb/dist/core.js', import.meta.url);
const { createPulseVaultCore, createLocalStorage, createMp4Sniffer, createChecksumValidator } =
  await import(distUrl.href);

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-integration-'));
const storage = createLocalStorage({ workspaceDir, reclaimGraceMs: 200 });
const core = createPulseVaultCore({
  basePath: '/pulsevault',
  storage,
  maxUploadSize: 64 * 1024 * 1024,
  // Same validation stack a real deployment runs: the client-declared
  // checksum verified against the finished bytes, then a magic-byte sniff.
  validatePayload: createChecksumValidator(createMp4Sniffer(storage)),
  logger: { info() {}, error() {} },
});

const server = http.createServer((req, res) => {
  core.handler(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`PV_PORT=${server.address().port}\n`);
});

async function shutdown() {
  await new Promise((resolve) => server.close(resolve));
  await core.shutdown();
  await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}

process.stdin.resume();
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
