#!/usr/bin/env node
// Builds the GitHub Pages compatibility page (compatibility.html) and the protocol reference files
// (protocol/) into a site directory. Nothing on the page is written by hand: it's generated from the
// protocol versions both sides declare (PROTOCOL.md §7).
//
// - Pulse app releases: `app-v*` git tags (the build workflows tag each store release); each one's
//   protocol range is `pulseProtocol` in its package.json. Plus main, if it isn't released yet.
// - PulseVault releases: `npm view @mieweb/pulsevault`; each one's protocol is its published
//   `pulseProtocol`. Plus the submodule pin, if it isn't released yet.
// - The protocol history, schemas and OpenAPI file: the pinned pulsevault-mieweb submodule.
//
// One historical fact is built in: releases published before `pulseProtocol` existed (app 2.0.x
// and earlier, pulsevault 0.3.0 and earlier) all speak protocol 1.
//
//   node scripts/build-compat-page.mjs --out _site     (the Pages workflow copies pages/ there first)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outIndex = process.argv.indexOf('--out');
const out = path.resolve(outIndex === -1 ? path.join(root, '_site') : process.argv[outIndex + 1]);
const pv = path.join(root, 'pulsevault-mieweb');
const LEGACY = { version: '1.0', min: 1, max: 1 };

const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
const tryRun = (...a) => {
  try {
    return run(...a);
  } catch {
    return null;
  }
};
const semverDesc = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
};

// ---- Pulse app versions ---------------------------------------------------------------------

const appPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tags = (tryRun('git', ['tag', '-l', 'app-v*']) ?? '').split('\n').filter(Boolean);
const apps = tags
  .map((tag) => {
    const pkg = JSON.parse(run('git', ['show', `${tag}:package.json`]));
    return { label: tag.slice('app-v'.length), protocol: pkg.pulseProtocol ?? LEGACY, note: '' };
  })
  .sort((a, b) => semverDesc(a.label, b.label));
if (!apps.some((a) => a.label === appPkg.version)) {
  apps.unshift({
    label: 'next',
    version: appPkg.version,
    protocol: appPkg.pulseProtocol ?? LEGACY,
    note: `main (${appPkg.version}), not released yet`,
  });
}
apps.push({ label: '2.0.x and earlier', protocol: LEGACY, note: '' });

// ---- PulseVault versions --------------------------------------------------------------------

const published = JSON.parse(
  tryRun('npm', ['view', '@mieweb/pulsevault', 'versions', '--json']) ?? '[]',
);
const servers = [...published].sort(semverDesc).map((version) => {
  const field = tryRun('npm', ['view', `@mieweb/pulsevault@${version}`, 'pulseProtocol', '--json']);
  return { label: version, protocol: field ? JSON.parse(field) : LEGACY, note: '' };
});
const pvPkg = JSON.parse(fs.readFileSync(path.join(pv, 'package.json'), 'utf8'));
const pvSha = tryRun('git', ['rev-parse', 'HEAD'], pv) ?? 'main';
const pinnedRelease = servers.find((s) => s.label === pvPkg.version);
if (
  pvPkg.pulseProtocol &&
  JSON.stringify(pinnedRelease?.protocol) !== JSON.stringify(pvPkg.pulseProtocol)
) {
  servers.unshift({
    label: 'next',
    protocol: pvPkg.pulseProtocol,
    note: `pinned ${pvSha.slice(0, 7)}, not released yet`,
  });
}

/** Merge neighbouring releases that speak the same protocol into one `newest – oldest` entry. */
function group(list) {
  const groups = [];
  for (const item of list) {
    const last = groups[groups.length - 1];
    if (
      last &&
      !item.note &&
      !last.note &&
      JSON.stringify(last.protocol) === JSON.stringify(item.protocol)
    ) {
      last.oldest = item.label;
    } else {
      groups.push({ ...item, oldest: item.label });
    }
  }
  return groups.map(({ oldest, ...g }) => ({
    ...g,
    label: oldest === g.label ? g.label : `${oldest} – ${g.label}`,
  }));
}
const serverColumns = group(servers);

// ---- compatibility --------------------------------------------------------------------------

function compat(app, server) {
  if (app.protocol.max < server.protocol.min) return { ok: false, text: 'Update Pulse' };
  if (app.protocol.min > server.protocol.max) return { ok: false, text: 'Update the server' };
  return { ok: true, text: `protocol ${Math.min(app.protocol.max, server.protocol.max)}` };
}

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const range = (p) => (p.min === p.max ? `${p.min}` : `${p.min}–${p.max}`);
const md = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

// ---- protocol history, schemas, reference files ---------------------------------------------

const protocolMd = fs.readFileSync(path.join(pv, 'PROTOCOL.md'), 'utf8');
const historySection = protocolMd.split('### 7.4 History')[1] ?? '';
const history = [...historySection.matchAll(/^\| (\d+\.\d+) \| (.+) \|$/gm)].map((m) => ({
  version: m[1],
  change: m[2],
}));

const schemaDir = path.join(pv, 'protocol', 'schemas');
const schemas = fs.existsSync(schemaDir)
  ? fs
      .readdirSync(schemaDir)
      .filter((f) => f.endsWith('.schema.json'))
      .sort()
  : [];
fs.mkdirSync(path.join(out, 'protocol', 'schemas'), { recursive: true });
for (const f of schemas)
  fs.copyFileSync(path.join(schemaDir, f), path.join(out, 'protocol', 'schemas', f));
const openapi = path.join(pv, 'protocol', 'openapi.json');
if (fs.existsSync(openapi)) fs.copyFileSync(openapi, path.join(out, 'protocol', 'openapi.json'));
const githubPv = `https://github.com/mieweb/pulsevault/blob/${pvSha}`;

// ---- page -----------------------------------------------------------------------------------

const matrix = `
      <div class="compat-scroll">
        <table class="compat-table">
          <thead>
            <tr><th scope="col">Pulse app ↓ · PulseVault →</th>${serverColumns
              .map(
                (s) =>
                  `<th scope="col">${esc(s.label)}<span class="compat-sub">protocol ${range(s.protocol)}${s.note ? ` · ${esc(s.note)}` : ''}</span></th>`,
              )
              .join('')}</tr>
          </thead>
          <tbody>
${apps
  .map(
    (a) =>
      `            <tr data-app="${esc(a.version ?? a.label)}"><th scope="row">${esc(a.label)}<span class="compat-sub">protocol ${range(a.protocol)}${a.note ? ` · ${esc(a.note)}` : ''}</span></th>${serverColumns
        .map((s) => {
          const c = compat(a, s);
          return `<td class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✓' : '✗'} ${esc(c.text)}</td>`;
        })
        .join('')}</tr>`,
  )
  .join('\n')}
          </tbody>
        </table>
      </div>`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Compatibility — Pulse</title>
  <meta name="description" content="Which Pulse app versions work with which PulseVault servers, and the upload protocol they share.">
  <link rel="icon" type="image/png" href="assets/icon.png">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div class="wrap">
    <nav class="nav">
      <a class="nav-brand" href="./"><img src="assets/icon.png" alt="Pulse app icon">Pulse</a>
      <div class="nav-links">
        <a href="./#features">Features</a>
        <a href="support.html">Support</a>
        <a href="privacy.html">Privacy</a>
        <a href="https://github.com/mieweb/pulse">GitHub</a>
      </div>
    </nav>

    <div class="page page-wide">
      <h1>Compatibility</h1>
      <p class="updated">Which Pulse app versions can upload to which PulseVault servers. Generated from the upload-protocol versions each release declares — nothing here is edited by hand.</p>

      <p id="your-app" class="compat-callout" hidden></p>

      <h2>App and server versions</h2>
      <p>A Pulse app and a PulseVault server work together when the protocol versions they speak overlap. Open <strong>About</strong> in the app to see your version and whether each server you've paired with is compatible.</p>
${matrix}

      <h2>Upload protocol versions</h2>
      <table class="compat-history">
        <thead><tr><th scope="col">Version</th><th scope="col">What changed</th></tr></thead>
        <tbody>
${history.map((h) => `          <tr><td>${esc(h.version)}</td><td>${md(h.change)}</td></tr>`).join('\n')}
        </tbody>
      </table>
      <p>A change to the major version breaks compatibility with older apps or servers; a minor version only adds things older ones can ignore.</p>

      <h2>Protocol reference</h2>
      <ul>
        <li><a href="protocol/">HTTP reference</a> — every route, generated from <a href="protocol/openapi.json">openapi.json</a></li>
        <li><a href="${githubPv}/PROTOCOL.md">PROTOCOL.md</a> — the full contract, for anyone building a compatible server</li>
${schemas.map((f) => `        <li><a href="protocol/schemas/${esc(f)}"><code>${esc(f)}</code></a></li>`).join('\n')}
      </ul>

      <p class="updated">Generated ${new Date().toISOString().slice(0, 10)} from mieweb/pulse and @mieweb/pulsevault ${esc(pvSha.slice(0, 7))}.</p>
    </div>
  </div>

  <footer>
    <div class="wrap footer-inner">
      <p>© ${new Date().getFullYear()} Medical Informatics Engineering, Inc.</p>
      <div class="footer-links">
        <a href="support.html">Support</a>
        <a href="compatibility.html">Compatibility</a>
        <a href="privacy.html">Privacy Policy</a>
        <a href="https://github.com/mieweb/pulse">GitHub</a>
      </div>
    </div>
  </footer>

  <script>
    // Opened from the app's About page with ?app=<version>&protocol=<min>-<max>: highlight that row.
    (function () {
      var params = new URLSearchParams(location.search);
      var app = params.get('app');
      if (!app) return;
      var row = document.querySelector('tr[data-app="' + CSS.escape(app) + '"]');
      var callout = document.getElementById('your-app');
      callout.hidden = false;
      if (row) {
        row.classList.add('compat-mine');
        callout.textContent = 'Your app: Pulse ' + app + ' — highlighted below.';
      } else {
        callout.textContent = 'Your app: Pulse ' + app + ' (protocol ' + (params.get('protocol') || '?') +
          '). It isn\\'t a release on this page; compare its protocol with the servers below.';
      }
    })();
  </script>
</body>
</html>
`;

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'compatibility.html'), html);
console.log(
  `wrote ${path.join(out, 'compatibility.html')}: ${apps.length} app rows × ${serverColumns.length} server columns, ${history.length} protocol versions, ${schemas.length} schemas`,
);
