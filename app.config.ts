import { execSync } from 'node:child_process';

import type { ConfigContext, ExpoConfig } from 'expo/config';

/** Runs a git command in the repo; `null` if git or the repo isn't available. */
function git(args: string): string | null {
  try {
    return (
      execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * `app.json` plus the pairing link host (above) and build info the About page shows (#155),
 * injected every time the config is read — by `expo start`, by `expo prebuild`, and by the native
 * build that embeds it.
 *
 * - `commit`: `GITHUB_SHA` in GitHub Actions, else the local checkout's HEAD.
 * - `ci`: whether this came from a CI build. A local build is labeled as such on the About page.
 * - `dirty`: a local build with uncommitted changes.
 * - `pulsevault`: the pulsevault commit pinned in the `pulsevault-mieweb` submodule — the server
 *   this app was built and tested against. Read from the tree, so it works without the submodule
 *   checked out.
 */
/**
 * Host of the https pairing links (#252): `https://<host>/pulse/open#…` opens Pulse when it's
 * installed (a Universal Link / App Link) and the store when it isn't. The host serves the iOS and
 * Android association files at its root. `PULSE_LINK_HOST` points a local build at a test host; set
 * it for both the native build and Metro, since the app reads it back from `extra.linkHost`.
 */
const LINK_HOST = process.env.PULSE_LINK_HOST || 'mieweb.github.io';

export default ({ config }: ConfigContext): ExpoConfig => {
  const ci = !!process.env.GITHUB_SHA;
  return {
    ...(config as ExpoConfig),
    ios: {
      ...config.ios,
      associatedDomains: [`applinks:${LINK_HOST}`],
    },
    android: {
      ...config.android,
      // The whole `/pulse/` prefix, so a later path (`/pulse/watch`) needs no new release; iOS
      // takes its paths from the association file instead.
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          data: [{ scheme: 'https', host: LINK_HOST, pathPrefix: '/pulse/' }],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
    extra: {
      ...config.extra,
      linkHost: LINK_HOST,
      build: {
        commit: process.env.GITHUB_SHA ?? git('rev-parse HEAD'),
        ci,
        dirty: !ci && !!git('status --porcelain --untracked-files=no'),
        builtAt: new Date().toISOString(),
        pulsevault: git('ls-tree HEAD pulsevault-mieweb')?.split(/\s+/)[2] ?? null,
      },
    },
  };
};
