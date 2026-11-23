# Release PulseKit

A PulseKit release is a git tag. Pushing `pulsekit-v<version>` runs
[`.github/workflows/release-embed.yml`](../../.github/workflows/release-embed.yml), which builds,
signs and publishes everything a host needs:

- a GitHub Release on the tag with one zip per xcframework, `PulseKit-xcframeworks.zip` (for
  CocoaPods), `PulseKit-dSYMs.zip`, the Hermes source map `PulseKit-main.jsbundle.map`,
  `THIRD_PARTY_NOTICES.md`, a size report and `SHA256SUMS`;
- `@mieweb/pulse-embed`, `@mieweb/capacitor-pulse` and `cordova-plugin-pulse` on npm at the tag's
  version, with provenance.

**Who can release:** someone who can push tags to mieweb/pulse. A tag pushed by a workflow's own
`GITHUB_TOKEN` starts nothing, so a person (or a PAT or App token) pushes it.

## Tags and versions

| Tag                    | npm dist-tag | GitHub Release |
| ---------------------- | ------------ | -------------- |
| `pulsekit-v0.2.0`      | `latest`     | release        |
| `pulsekit-v0.2.0-rc.1` | `rc`         | pre-release    |

- The version comes from the tag. The workflow writes it into the three packages,
  `embed/app.json` and the Cordova `plugin.xml` in its own checkout; nothing is committed, so the
  repo keeps `0.0.0-dev`.
- After packaging, the tag, every package and `PulseKit.framework`'s `Info.plist` must agree, or
  nothing is published.
- PulseKit's `CFBundleShortVersionString` is only the numeric `X.Y.Z`, also on `-rc.N` tags,
  because App Store Connect refuses a suffix there. `getInfo().sdkVersion` and the npm packages
  carry the full version.
- `app-v*` tags (store builds of the Pulse app) never start this workflow, and nothing in it runs
  on pull requests.

## Cut a release candidate

1. Make sure the commit you're tagging passes CI, including the `embed-check` job.
2. Tag and push:

   ```sh
   git tag pulsekit-v0.2.0-rc.1 <commit>
   git push origin pulsekit-v0.2.0-rc.1
   ```

3. Watch the run: `gh run watch --repo mieweb/pulse` and pick the PulseKit Release run.
4. When it's green, check a download: download the release's assets and run
   `shasum -a 256 -c SHA256SUMS` in that folder.
5. Try it in a host (the Capacitor test host or your app) and check that `isAvailable()` is true on an iPhone and
   that `getInfo().gitSha` is the tagged commit. Install this release's own packages: while `NPM_PUBLISH` isn't `true`, npm's `@rc`
   is an older version or nothing, so install from the Release:
   `BASE=https://github.com/mieweb/pulse/releases/download/pulsekit-v<version>` then
   `npm install --save-exact $BASE/mieweb-pulse-embed-<version>.tgz $BASE/mieweb-capacitor-pulse-<version>.tgz`.
   Once npm publishing is on, `npm install --save-exact @mieweb/capacitor-pulse@rc` works too.

A green run is not enough on its own: `pulsekit-v0.1.0-rc.4` built, packaged and published a
release whose `PulseKit` binary had no `PulseKit` class, because the facade's Swift files were
compiled into the wrong target. Hosts linking it answered `isAvailable()` false. Packaging now
refuses a PulseKit slice without the class, but step 5 on a phone is the check that counts.

For a final release, tag `pulsekit-v0.2.0` the same way.

## Choose whether the release runs without a screen

The `headless` capability (host writes and uploads with nothing on screen) is a build-time switch,
on unless the prebuild runs with `PULSEKIT_HEADLESS=0` ([dev-loop.md](dev-loop.md#with-the-headless-capability)).
`release-embed.yml` runs `npm run prebuild -- --platform ios` without the variable, so a release reports
`headless`. To ship a release without it, set `PULSEKIT_HEADLESS: '0'` on that step. Hosts read the result from `getInfo().capabilities` and change how they resume uploads
([uploads.md](uploads.md#paused-uploads)), so say in the release notes which way it went.

## After a final release: re-pin TimeHuddle

TimeHuddle pins the client and the Capacitor plugin exactly. After `pulsekit-vX.Y.Z` is published,
in TimeHuddle: `npm install --save-exact @mieweb/pulse-embed@X.Y.Z @mieweb/capacitor-pulse@X.Y.Z`
(or the Release's `.tgz` files while npm publishing is off), remove any vendored `0.0.0-dev`
client tarball, run its native-sync check, and build it on an iPhone as in
[timehuddle-ios.md](timehuddle-ios.md).

## When a release run fails

The GitHub Release is created before npm, and npm takes the packages one at a time, so a failure
can leave part of a release behind. A re-run stops at "Check that nothing is published at this
version yet".

- **Nothing reached npm:** delete the GitHub Release and keep the tag
  (`gh release delete <tag> --yes --repo mieweb/pulse`), fix the cause and re-run the workflow.
- **Some packages reached npm:** that version can't be published again. Tag the next version (the
  next `-rc.N` for a release candidate).
- **A failure before the Release exists** (prebuild, pods, the build, signing): fix it on the
  branch and push the next `-rc.N` tag on the fixed commit.

## Credentials the workflow uses

| What                 | Where it comes from                                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signing certificate  | The org's fastlane match repo, read-only, through mieweb/actions v2.5.0's match setup. Secrets: `APPLE_TEAM_ID`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_P8_BASE64`, `MATCH_GIT_BASIC_AUTHORIZATION`, `MATCH_PASSWORD` (the same as the app's iOS build). |
| npm                  | Trusted publishing (OIDC), the way mieweb/pulsevault publishes: no token. Each package's trusted publisher on npmjs.com is GitHub Actions, repository `mieweb/pulse`, workflow `release-embed.yml`. A new package's first version is published by hand (below). |
| The Release          | The workflow's `GITHUB_TOKEN` (`contents: write`, `id-token: write`).                                                                                                                                                                                                       |

## Symbolicate a crash

Every release attaches what you need to read a PulseKit crash from a host app:

- **Native frames** (Swift, Objective-C, C++): unzip `PulseKit-dSYMs.zip` from the release whose
  version matches the host's `getInfo().sdkVersion` and `gitSha`. Add the dSYMs to the crash
  reporter the host uses, or symbolicate an address with
  `atos -arch arm64 -o <Framework>.framework.dSYM/Contents/Resources/DWARF/<Framework> -l <load address> <address>`.
- **JavaScript frames** (Hermes): the release's `PulseKit-main.jsbundle.map` maps the bundle's
  positions back to Pulse's source. React Native's `metro-symbolicate` reads it:
  `npx metro-symbolicate PulseKit-main.jsbundle.map < stack.txt`.

> **UNTESTED.** Both procedures are standard for these files, but neither has been tried on a
> PulseKit crash yet.

## The first npm version of a new package

Trusted publishing can only be set up for a package that already exists on npm, so a new package's
first version goes up by hand, once. This is how `@mieweb/pulsevault` started too.

1. Let the release run publish the GitHub Release. While the repository variable `NPM_PUBLISH`
   isn't `true`, its npm step is skipped and the three npm packages are attached to the Release as
   `.tgz` files, built from the tag with the version stamped and `Package.swift` and
   `PulseKit.podspec` written, and listed in `SHA256SUMS`.
2. Download those three files and check them:

   ```sh
   V=<version>
   gh release download "pulsekit-v$V" -R mieweb/pulse -p '*.tgz' -p SHA256SUMS
   shasum -a 256 -c --ignore-missing SHA256SUMS
   ```

   `0.1.0-rc.4` came before this workflow: its `SHA256SUMS` doesn't list the tarballs. Check them
   against `npm-packages.sha256` instead (`-p npm-packages.sha256`, then
   `shasum -a 256 -c npm-packages.sha256`).

   Don't pack them yourself: a fresh checkout has no `node_modules` for `pulse-embed`'s `prepack`
   (run `npm ci` at the root first), and the version stamp only runs through the workflow's call,
   `node -e "import('./embed/scripts/lib/release-version.mjs').then((m) => m.cli(process.argv.slice(1)))" stamp "$V"`.
3. As a member of the `mieweb` npm org (`npm login`), publish each tarball:
   `npm publish <file>.tgz --tag rc --access public --provenance=false` (`--tag latest` for a final
   release). `@mieweb/pulse-embed`'s manifest asks for provenance, which npm can only generate in a
   supported CI run, so this first version goes up without an attestation; every later version
   comes from the workflow with one. The unscoped `cordova-plugin-pulse` is then owned by that
   account; add the org's maintainers.
4. On npmjs.com, for each package: Settings → Trusted publisher → GitHub Actions,
   organization `mieweb`, repository `pulse`, workflow `release-embed.yml`.
   Then set the repository variable `NPM_PUBLISH` to `true` (Settings → Secrets and variables →
   Actions → Variables). From then on the workflow publishes with no token. Until it is set, the
   npm step is skipped and the Release's `.tgz` assets (listed in `SHA256SUMS`) are how hosts install.
