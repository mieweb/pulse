/**
 * What the About page (#155) says about this build: version, build number, commit, build date,
 * and the pulsevault commit it was built against. The values come from `extra.build`, which
 * `app.config.ts` injects at build time — nothing here is maintained by hand.
 *
 * Pure (no React Native imports) so it's unit tested; the app passes it `Constants.expoConfig`.
 */

/** The shape `app.config.ts` writes to `extra.build`. */
type BuildExtra = {
  commit?: string | null;
  ci?: boolean;
  dirty?: boolean;
  builtAt?: string | null;
  pulsevault?: string | null;
};

/** The slice of the Expo config this reads. */
export type BuildConfig = {
  version?: string;
  ios?: { buildNumber?: string };
  android?: { versionCode?: number };
  extra?: { build?: BuildExtra };
};

export type BuildInfo = {
  version: string;
  /** iOS `buildNumber` / Android `versionCode`; `null` when the build didn't set one (local). */
  buildNumber: string | null;
  /** Short commit hash, or `null` if unknown. */
  commit: string | null;
  /** Built by CI (`GITHUB_SHA` set), as opposed to on someone's machine. */
  ci: boolean;
  /** A local build from a checkout with uncommitted changes. */
  dirty: boolean;
  builtAt: Date | null;
  /** Short hash of the pinned pulsevault commit, or `null` if unknown. */
  pulsevault: string | null;
};

const short = (hash: string | null | undefined) => (hash ? hash.slice(0, 7) : null);

export function readBuildInfo(config: BuildConfig | null | undefined, platform: string): BuildInfo {
  const build = config?.extra?.build ?? {};
  const buildNumber =
    platform === 'ios'
      ? (config?.ios?.buildNumber ?? null)
      : platform === 'android' && config?.android?.versionCode != null
        ? String(config.android.versionCode)
        : null;
  const builtAt = build.builtAt ? new Date(build.builtAt) : null;
  return {
    version: config?.version ?? 'unknown',
    buildNumber,
    commit: short(build.commit),
    ci: build.ci ?? false,
    dirty: build.dirty ?? false,
    builtAt: builtAt && !Number.isNaN(builtAt.getTime()) ? builtAt : null,
    pulsevault: short(build.pulsevault),
  };
}

/** `2.1.0 (45)`, or just `2.1.0` without a build number. */
export function versionLabel(info: BuildInfo): string {
  return info.buildNumber ? `${info.version} (${info.buildNumber})` : info.version;
}

/** `abc1234`, `abc1234 · local build`, or `abc1234 · local build, modified`. */
export function commitLabel(info: BuildInfo): string {
  const hash = info.commit ?? 'unknown';
  if (info.ci) return hash;
  return `${hash} · local build${info.dirty ? ', modified' : ''}`;
}

/** Unambiguous for bug reports: `2026-09-24 14:05 UTC`. */
export function utcLabel(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
