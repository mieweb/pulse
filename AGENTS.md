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
