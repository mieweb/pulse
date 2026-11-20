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
5. Try it in a host: `npm install --save-exact @mieweb/capacitor-pulse@rc` in the Capacitor test
   host or your app, and check that `isAvailable()` is true on an iPhone and that
   `getInfo().gitSha` is the tagged commit.

A green run is not enough on its own: `pulsekit-v0.1.0-rc.4` built, packaged and published a
release whose `PulseKit` binary had no `PulseKit` class, because the facade's Swift files were
compiled into the wrong target. Hosts linking it answered `isAvailable()` false. Packaging now
refuses a PulseKit slice without the class, but step 5 on a phone is the check that counts.

For a final release, tag `pulsekit-v0.2.0` the same way.

## Choose whether the release runs without a screen

The `headless` capability (host writes and uploads with nothing on screen) is a build-time switch,
off unless the prebuild runs with `PULSEKIT_HEADLESS=1` ([dev-loop.md](dev-loop.md#with-the-headless-capability)).
`release-embed.yml` runs `npm run prebuild -- --platform ios` without it, so a release reports no
`headless` and shows "Preparing…" instead. To ship it on, set `PULSEKIT_HEADLESS: '1'` on that
step. Hosts read the result from `getInfo().capabilities` and change how they resume uploads
([uploads.md](uploads.md#paused-uploads)), so say in the release notes which way it went.

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
| npm, first publish   | `NPM_TOKEN` if the repo sets one, otherwise the org secret `NPM_PUBLISH_SECRET`. A package's first version needs a token, because trusted publishing can only be set up for a package that exists.                                                                          |
| npm, later publishes | Trusted publishing (OIDC) on npmjs.com for each package, bound to mieweb/pulse and `release-embed.yml`. Once that is set up, no token is needed.                                                                                                                            |
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

## Before the first release candidate of a new package

- Someone has to own the `cordova-plugin-pulse` name on npm (it is unscoped).
- After the first publish, set up trusted publishing for each package on npmjs.com, so later
  releases need no token.
