# Repository instructions

These are the shared repository instructions for coding agents and Copilot. General engineering guidance is adapted from the [MIE open-source template at `666e900`](https://github.com/mieweb/template-mieweb-opensource/blob/666e90027cd15b377831ae69ccfd59faeaea4233/.github/copilot-instructions.md), with Pulse-specific workflow and review requirements below.

## Pull request scope and reviewer effort

- Optimize for the human reviewer's total effort. Use the smallest complete, cohesive change that delivers the agreed outcome; neither fewer lines nor more PRs automatically makes review easier. Exclude unrelated features, refactors and dependency upgrades.
- Default to one PR per agreed plan. Milestones and implementation phases are checklist checkpoints inside that PR, not instructions to create branches or dependent PRs. Preserve the user's agreed review boundary.
- Keep tightly coupled types, schema/migrations, runtime wiring, recovery behavior, tests and required documentation together when a reviewer needs them to establish correctness. Do not split them into artificial foundation/runtime/transfer layers that require reconstructing one behavior across several PRs.
- Split work only when doing so reduces human review effort and each resulting PR has a clear purpose, is independently understandable and useful, and passes its relevant checks against its stated base. Do not publish inactive scaffolding solely to reduce a later diff or split to meet an arbitrary file/line limit. If a cohesive change is necessarily broad, provide a concise review map of the affected subsystems and their interactions.
- Prefer independent PRs for independent outcomes. Create dependent PRs only for a necessary prerequisite; keep the chain as short as possible and explain the dependency and merge order. A request for one PR per plan does not authorize a separate stack for every phase within a plan.
- Write the PR title and description around the final change: the problem, resulting behavior, affected subsystems, validation and material risks or remaining acceptance work. State any required predecessor by PR number and why it is required. A reviewer should understand the scope, breadth and depth without reading other PR descriptions or this conversation.

Before opening, splitting or substantially rescoping a PR, verify this checklist and record the relevant conclusions in its description:

- [ ] The PR has one clear outcome that can be summarized in one sentence; every changed file supports it.
- [ ] The diff includes the implementation, tests, migrations and documentation needed to assess that outcome, with unrelated work removed.
- [ ] A reviewer can assess correctness from this diff and its stated base; no required behavior or validation is hidden in another unmerged PR.
- [ ] Each dependency is necessary and explicitly linked with its reason and merge order; avoidable dependencies have been removed.
- [ ] Relevant checks ran against the actual PR contents/base, and skipped coverage or remaining release gates are stated accurately.

## Project and working practices

- Pulse is an Expo / React Native / TypeScript application with native media engines. Follow the existing platform architecture and conventions in the code being changed.
- Inspect `git status` before edits, preserve existing work and coordinate ownership of shared files and lockfiles. Keep changes focused on the requested outcome.
- Use Node 24 meeting `package.json`'s `>=24.3.0` engine requirement, npm and the root `package-lock.json`. Read `package.json` for actual scripts; preserve the project's package manager and avoid unrelated dependency upgrades.
- Native engines and PulseVault are pinned submodules. Change their pointers deliberately and include the reason and required build/verification steps. Use each dependency's own package manager and lockfile when building it.
- Read the relevant design, migration and recovery documentation before changing durable state. Preserve existing user data and recovery inputs; run destructive checks only against isolated fixtures or sandboxes.

## Code quality and organization

- Prefer the simplest solution that fully solves the problem. Use clear names and small, focused functions; avoid speculative abstractions and new components that merely move complexity elsewhere.
- Keep knowledge and shared behavior in one authoritative place. Reuse existing utilities or extract a focused helper when it removes meaningful duplication without obscuring the code.
- Give folders a clear purpose. Explain non-obvious relationships with a short README or nearby documentation rather than creating miscellaneous collections of unrelated files.
- Keep refactoring incremental and within the requested scope. Preserve behavior and use relevant before/after checks for behavior-sensitive refactors. Propose larger architectural changes separately unless already requested.
- Remove obsolete code when the change makes its removal safe and relevant. Preserve historical data, migration paths and recovery logic until their replacement and retention policy are verified; use Git history for ordinary removed source.

## UI, accessibility and localization

- Follow existing React Native component and styling conventions. Keep styles scoped; use semantic HTML and accessible browser controls where web code is involved.
- Give interactive controls appropriate native accessibility labels, roles and state. Preserve sensible focus order and screen-reader announcements for important changes; use semantic HTML and ARIA as appropriate on the web.
- Keep user-facing text separate from business logic and follow the localization conventions present in the affected area. Preserve Unicode, use locale-aware date/number formatting, and consider text expansion and RTL layouts when changing UI. New translation frameworks or language selectors require an agreed product need.
- For UI changes, update affected documentation and include before/after screenshots or a short clip in the PR. Record the platform and any unverified interaction or accessibility behavior.
- Use native simulator/device checks for native behavior and browser tools for web behavior. Leave an interactive browser session available for the user unless asked to close it.

### One-handed phone use

- Design app-owned phone controls so each operation can be completed with one thumb while holding the phone in either hand. Keep required commands in the lower half of the UI, with a reachable path to Back, Close, Cancel and the primary action in every actionable state, including loading, errors, sheets and keyboard entry. A bottom control at the opposite screen edge is not sufficient evidence of reachability.
- Keep a reachable button alternative to required swipes, long presses, dragging and multi-touch gestures. Preserve gesture shortcuts without making them the only way to complete an operation. Account for safe areas, small screens, large text, RTL, accessibility focus and gesture conflicts with navigation, scrolling, recording and editing.
- Document and review any exception before treating it as accepted. Name the affected operation and state, why lower placement or a button alternative is unsuitable, and the reachable fallback or follow-up. Distinguish OS-owned UI (for example permission prompts, Photos/Files pickers and share sheets) from app-owned UI; accessibility or layout constraints do not silently waive the requirement. Record any unverified reach or accessibility behavior.
- Every PR must state whether it changes a phone flow. For applicable PRs, review the complete affected flow with both hands, record platform/device or simulator and text-size coverage, attach before/after evidence, and list exceptions and remaining physical reach checks. For PRs without phone UI or flow changes, record a brief N/A reason. Simulator screenshots establish layout, not actual thumb reach. Use [the one-handed navigation audit](docs/one-handed-navigation.md) for scope, deferred work and acceptance mapping.

## Documentation and CI

- Update relevant behavior, architecture and build documentation in the same PR as the change. Link authoritative documents instead of duplicating rules or explanations.
- Use Mermaid for workflow and architecture diagrams, with descriptive names and the simplest diagram that explains the relationships.
- Prefer locally runnable scripts for build and CI logic. Keep GitHub Actions as thin wrappers around commands developers can reproduce locally, and document required environment/setup steps when they change.

## Verification

Select checks appropriate to the changed behavior. The repository's standard source checks are:

```bash
npx tsc --noEmit
npm run lint
npm test -- --runInBand
node scripts/gen-protocol-types.mjs --check
```

- Run focused regressions while developing, then the relevant complete checks before claiming completion. For documentation-only changes, check changed-file formatting, links and scope; application tests are unnecessary unless the change affects execution.
- Check formatting only for the changed files with the repository's Prettier configuration. Avoid unrelated whole-repository rewrites.
- Report the actual commands, results, skipped coverage and remaining risks. A skipped integration suite is not a pass; a JavaScript bundle export does not prove native device behavior or durability.
- Keep implementation checklists honest: mark an item complete only when its behavior is implemented and the supporting evidence is recorded. Milestone reviews are evidence checkpoints, not automatic permission waits.

## Embedding Pulse in a host app (Capacitor/Cordova)

When the task is adding Pulse to another app (not changing this repo), follow [docs/embedding/README.md](docs/embedding/README.md) top to bottom. It has the install commands, the `Info.plist` keys, the page code and a "Done when" checklist; [capacitor.md](docs/embedding/capacitor.md) and [cordova.md](docs/embedding/cordova.md) add what is specific to each host, and [contract.md](docs/embedding/contract.md) is the reference for methods, results and error codes. When a doc and [`embed/packages/pulse-embed/src/types.ts`](embed/packages/pulse-embed/src/types.ts) disagree, the types are right.

- Install `@mieweb/pulse-embed` plus one plugin, `@mieweb/capacitor-pulse` (Capacitor 8, Swift Package Manager) or `cordova-plugin-pulse` (cordova-ios 8+), at the same exact version from the npm `rc` tag. Releases are prereleases.
- Copy project setup from the reference hosts [`embed/hosts/cap-host`](embed/hosts/cap-host/) and [`embed/hosts/cordova-host`](embed/hosts/cordova-host/), not their page code: their page talks to the plugin directly, and a host app talks only to `@mieweb/pulse-embed`.
- iPhone only, iOS 16.4 or later. iPad, Mac and Android report `supported: false` (the Android plugins are stubs), so the host keeps its own fallback where `isAvailable()` is false.
- Call `configure({ uploadMode: 'file' })` once per page load, before anything else. The default `'pulse'` mode, the drafts API and accounts aren't in this version.
- One flow at a time: a second `open` while one is open rejects with `busy`.
- Every result lands in a results inbox. Handle it from the promise, the `flowResult` event and `pendingResults()` (read on every page load) with one idempotent handler, upload the MP4 before `acknowledge(requestId)`, and acknowledge every result.
- Test the host without a device with `createFakePulse` and `runPulseContract` from `@mieweb/pulse-embed/testing`.
- Don't claim a step works on a device unless it was run there. Keep UNTESTED labels in the docs honest ([support-matrix.md](docs/embedding/support-matrix.md)).

## Working on the embed in this repo

PulseKit is the second shell over the same `src/` code ([docs/architecture.md](docs/architecture.md)).

- **Where the code lives:** `embed/src/` (the PulseKit shell: entry, flow stack, results), `embed/native/ios/` (the Swift facade, `PulseKit*.swift`, and the envelope vectors), `embed/packages/` (`pulse-embed`, `capacitor-pulse`, `cordova-plugin-pulse`), `embed/scripts/` (packaging and release generators), `embed/hosts/` (reference hosts; nothing in them ships). The map is in [embed/README.md](embed/README.md).
- **Lint zones:** shared code (`src/features`, `core`, `db`, `utils`, `components`, `hooks`, `constants`) never imports `src/app` or `embed/`, and doesn't use `expo-router`, `expo-status-bar` or `expo-linking`; features PulseKit runs never import a standalone-only feature. ESLint enforces these, and `src/test-support/lint-zones.test.ts` checks the rules still catch their cases. The full table is in [docs/architecture.md](docs/architecture.md#boundary-rules-and-what-enforces-them).
- **Native dependencies:** classify every new one in `embed/deps.json` (and add it to `embed/package.json` if PulseKit links it), then run `npm run check:embed`.
- **Contract changes:** `embed/packages/pulse-embed/src/types.ts` is the source of truth. Update [docs/embedding/contract.md](docs/embedding/contract.md) with it, and `embed/native/ios/vectors/envelope.json` when an envelope rule changes. Contract fields and error codes are only ever added.
- **Generated files:** `embed/packages/capacitor-pulse/Package.swift` and `embed/packages/cordova-plugin-pulse/PulseKit.podspec` are written by `embed/scripts/write-package-swift.mjs` and `write-podspec.mjs`; edit their templates in `embed/scripts/lib/`. Package versions stay `0.0.0-dev` in the repo; a `pulsekit-v<version>` tag stamps them at release ([releasing.md](docs/embedding/releasing.md)).
- **Checks** for an embed change, besides the standard ones under Verification:

  ```bash
  npx tsc --noEmit -p embed
  npx tsc --noEmit -p embed/packages/pulse-embed
  npx jest embed            # the shell, the client, its fake and contract suite, the release scripts
  npm run check:embed       # PulseKit's JS bundles and dependency rules; no native build
  ```

  When you change the facade's envelope rules, also run the Swift vectors on a Mac ([embed/native/ios/vectors/README.md](embed/native/ios/vectors/README.md)). Building PulseKit itself is in [docs/embedding/dev-loop.md](docs/embedding/dev-loop.md).
