// Boots the pulsevault submodule's BUILT core on an ephemeral port for the
// app's cross-repo integration suite (src/features/upload/pv-integration.test.ts).
// Prints "PV_PORT=<port>" on stdout once listening; exits when stdin closes
// (so a killed jest run can't leak servers).
//
// Storage is selected by PV_STORAGE:
//   - unset / "local": local-FS storage in a temp dir (TUS profile only) —
//     deleted on exit.
//   - "s3-mock": the submodule's in-process mock S3 + createS3Storage, which
//     makes /capabilities advertise the presigned direct-upload profile — the
//     real §9 wire surface (grant → PUT → complete) for the client suite.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const distUrl = new URL('../pulsevault-mieweb/dist/core.js', import.meta.url);
const {
  createPulseVaultCore,
  createLocalStorage,
  createS3Storage,
  createMp4Sniffer,
  createS3Mp4Sniffer,
  createChecksumValidator,
  createS3ChecksumValidator,
} = await import(distUrl.href);

let storage;
let cleanup = async () => {};
// Same validation stack a real deployment runs: the client-declared checksum
// verified against the finished bytes, then a magic-byte sniff — each in its
// adapter-correct flavor (the local validator hashes localPath; the S3 one
// streams the object via digestAll).
let validatePayload;

if (process.env.PV_STORAGE === 's3-mock') {
  const mockUrl = new URL('../pulsevault-mieweb/test/mock-s3.mjs', import.meta.url);
  const { startMockS3 } = await import(mockUrl.href);
  const bucket = 'pv-integration';
  const mock = await startMockS3({ buckets: [bucket] });
  storage = await createS3Storage({
    bucket,
    endpoint: mock.endpoint,
    region: 'us-east-1',
    accessKeyId: 'MOCKS3',
    secretAccessKey: 'MOCKS3',
    forcePathStyle: true,
    clientConfig: {
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    },
  });
  validatePayload = createS3ChecksumValidator(storage, createS3Mp4Sniffer(storage));
  cleanup = async () => {
    await mock.close();
  };
} else {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-integration-'));
  storage = createLocalStorage({ workspaceDir });
  validatePayload = createChecksumValidator(createMp4Sniffer(storage));
  cleanup = async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => {});
  };
}

const core = createPulseVaultCore({
  basePath: '/pulsevault',
  storage,
  maxUploadSize: 64 * 1024 * 1024,
  validatePayload,
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

let shuttingDown = false;
async function shutdown() {
  // stdin 'end' and 'close' both fire on a normal teardown — run once.
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise((resolve) => server.close(resolve));
  await core.shutdown();
  await cleanup();
  process.exit(0);
}

process.stdin.resume();
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
