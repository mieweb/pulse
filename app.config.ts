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
 * `app.json` plus build info the About page shows (#155), injected every time the config is
 * read — by `expo start`, by `expo prebuild`, and by the native build that embeds it.
 *
 * - `commit`: `GITHUB_SHA` in GitHub Actions, else the local checkout's HEAD.
 * - `ci`: whether this came from a CI build. A local build is labeled as such on the About page.
 * - `dirty`: a local build with uncommitted changes.
 * - `pulsevault`: the pulsevault commit pinned in the `pulsevault-mieweb` submodule — the server
 *   this app was built and tested against. Read from the tree, so it works without the submodule
 *   checked out.
 */
export default ({ config }: ConfigContext): ExpoConfig => {
  const ci = !!process.env.GITHUB_SHA;
  return {
    ...(config as ExpoConfig),
    extra: {
      ...config.extra,
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
