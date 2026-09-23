import { type BuildInfo, commitLabel, utcLabel, versionLabel } from './build-info';

/** One paired server's compatibility with this app, from a live `/capabilities` check. */
export type ServerCompat = { server: string; host: string } & (
  | { status: 'checking' }
  | { status: 'compatible'; minVersion: number; maxVersion: number }
  | { status: 'app-too-old' | 'app-too-new' | 'unreachable' }
);

export type DeviceInfo = { os: string; osVersion: string | null; model: string | null };

/** Short status text, shared by the About page and Copy details. */
export function compatLabel(compat: ServerCompat): string {
  switch (compat.status) {
    case 'checking':
      return 'Checking…';
    case 'compatible':
      return compat.minVersion === compat.maxVersion
        ? `Compatible · protocol ${compat.minVersion}`
        : `Compatible · protocol ${compat.minVersion}–${compat.maxVersion}`;
    case 'app-too-old':
      return 'Needs a newer version of Pulse';
    case 'app-too-new':
      return 'Server needs an update';
    case 'unreachable':
      return "Couldn't reach it";
  }
}

/**
 * Everything the About page shows, as one plain-text block for a bug report (Copy details, and
 * the header of shared logs).
 */
export function formatDetails({
  build,
  device,
  protocol,
  servers,
}: {
  build: BuildInfo;
  device: DeviceInfo;
  protocol: number;
  servers: ServerCompat[];
}): string {
  const lines = [
    `Pulse ${versionLabel(build)}`,
    `Commit: ${commitLabel(build)}`,
    `Built: ${build.builtAt ? utcLabel(build.builtAt) : 'unknown'}`,
    `Built against PulseVault: ${build.pulsevault ?? 'unknown'}`,
    `Device: ${[device.model, [device.os, device.osVersion].filter(Boolean).join(' ')]
      .filter(Boolean)
      .join(' · ')}`,
    `Upload protocol: v${protocol}`,
    servers.length === 0 ? 'Paired servers: none' : 'Paired servers:',
    ...servers.map((s) => `  ${s.host} — ${compatLabel(s)}`),
  ];
  return lines.join('\n');
}
