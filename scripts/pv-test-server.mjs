// Boots the pulsevault submodule's BUILT core on an ephemeral port for the app's cross-repo
// integration suite (src/features/upload/core/pv-integration.test.ts). Configured like a real
// deployment: local-FS storage, the checksum + magic-byte validators, capability tokens, and
// (from protocol 2.2) read-only view links.
//
// Besides the pulsevault routes under /pulsevault, it serves GET /pair, which mints a pairing
// link exactly as a deployment's dashboard would (fresh artifactId, a token scoped to it,
// `buildUploadLink`) and returns `{ link }`, and GET /events, the artifact events it has seen
// (what a deployment's `onArtifactEvent` would get).
//
// GET /token?artifactId=<id> mints a fresh token for an artifact /pair made: `{ token, expiresAt }`
// (2 h). /pair and /token answer with `Access-Control-Allow-Origin: *`, so a test host's WebView
// (embed/hosts/cap-host, "Host services: test server") can call them from its own origin.
//
// Prints "PV_PORT=<port>" on stdout once listening; exits when stdin closes, so a killed jest
// run can't leak servers. It listens on PV_TEST_HOST (default 127.0.0.1) and PV_TEST_PORT
// (default 0, an ephemeral port); a device run fixes the port and keeps stdin open:
//   PV_TEST_PORT=8787 tail -f /dev/null | node scripts/pv-test-server.mjs
//
// PV_CORE (optional) is the path to another build of `@mieweb/pulsevault/core`, e.g. the
// latest release installed from npm; by default it's the pinned submodule's build.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distUrl = process.env.PV_CORE
  ? pathToFileURL(path.resolve(process.env.PV_CORE))
  : new URL('../pulsevault-mieweb/dist/core.js', import.meta.url);
const {
  buildUploadLink,
  createCapabilityAuthorize,
  createChecksumValidator,
  createLocalStorage,
  createMp4Sniffer,
  createPulseVaultCore,
  issueCapabilityToken,
  // Protocol 2.2+ only — absent from older builds, which then offer no view links.
  createViewLinkIssuer,
} = await import(distUrl.href);

const BASE_PATH = '/pulsevault';
const SECRET = 'pv-integration-secret';
const KEY_ID = 'pv-integration';
const ISSUER = 'pv-integration';
const lookupSecret = (keyId) => (keyId === KEY_ID ? SECRET : null);

const LISTEN_HOST = process.env.PV_TEST_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.PV_TEST_PORT || 0);
if (!Number.isInteger(LISTEN_PORT) || LISTEN_PORT < 0 || LISTEN_PORT > 65535) {
  throw new Error(`PV_TEST_PORT must be a port number (got "${process.env.PV_TEST_PORT}")`);
}

const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-integration-'));
const storage = createLocalStorage({ workspaceDir });

// validatePayload runs for every kind. The client's checksum is verified for all of them; the
// MP4 magic-byte sniff only applies to videos (captions, manifests and thumbnails aren't MP4s).
const validateAny = createChecksumValidator();
const validateVideo = createChecksumValidator(createMp4Sniffer(storage));

const events = [];

const core = createPulseVaultCore({
  basePath: BASE_PATH,
  storage,
  maxUploadSize: 64 * 1024 * 1024,
  validatePayload: (request, ctx) =>
    ctx.kind === 'video' ? validateVideo(request, ctx) : validateAny(request, ctx),
  authorize: createCapabilityAuthorize(lookupSecret, { issuer: ISSUER }),
  onArtifactEvent: (event) => void events.push(event),
  ...(createViewLinkIssuer
    ? {
        issueViewLink: createViewLinkIssuer({
          keyId: KEY_ID,
          secret: SECRET,
          issuer: ISSUER,
          expirySeconds: 3600,
        }),
      }
    : {}),
  logger: { info() {}, error() {} },
});

const TOKEN_SECONDS = 2 * 60 * 60;
const CORS = { 'access-control-allow-origin': '*' };
/** Artifacts /pair has minted; /token only signs for these. */
const paired = new Set();

let port = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/pair') {
    const artifactId = randomUUID();
    paired.add(artifactId);
    const token = issueCapabilityToken(artifactId, SECRET, {
      keyId: KEY_ID,
      issuer: ISSUER,
      expirySeconds: 600,
    });
    const link = buildUploadLink({
      server: `http://127.0.0.1:${port}${BASE_PATH}`,
      artifactId,
      token,
    });
    res.writeHead(200, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify({ link }));
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/token?')) {
    const artifactId = new URLSearchParams(req.url.slice('/token?'.length)).get('artifactId');
    if (!artifactId || !paired.has(artifactId)) {
      res.writeHead(404, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: 'unknown artifactId' }));
      return;
    }
    const expiresAt = Date.now() + TOKEN_SECONDS * 1000;
    const token = issueCapabilityToken(artifactId, SECRET, {
      keyId: KEY_ID,
      issuer: ISSUER,
      expirySeconds: TOKEN_SECONDS,
    });
    res.writeHead(200, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify({ token, expiresAt }));
    return;
  }
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(events));
    return;
  }
  void core.handler(req, res, () => {
    res.statusCode = 404;
    res.end();
  });
});

await new Promise((resolve) => server.listen(LISTEN_PORT, LISTEN_HOST, resolve));
port = server.address().port;
process.stdout.write(`PV_PORT=${port}\n`);

let shuttingDown = false;
async function shutdown() {
  // stdin 'end' and 'close' both fire on a normal teardown — run once.
  if (shuttingDown) return;
  shuttingDown = true;
  server.closeAllConnections();
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
