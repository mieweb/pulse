# Persistence review and follow-up plans

[PR #296](https://github.com/mieweb/pulse/pull/296) contains the complete canonical Pulse persistence plan and implementation, reviewed against `main`. Document/codecs, canonical saves, SQLite projection/recovery, migration retention, v2 transfer, exact restore and library backup belong to this one review. The persistence milestones are progress checkpoints within the PR.

The earlier four-PR split has been consolidated into #296. No merge sequence between persistence PRs is required. The existing `review-stack.md` filename is retained for incoming links.

## Plan-sized pull requests

| Plan                                                                           | Pull request                                                      | Status                                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [Canonical Pulse persistence](./sqlite-pulse-implementation-plan.md)           | [#296](https://github.com/mieweb/pulse/pull/296), based on `main` | Complete implementation under review; native release checks remain open. |
| [Native component for Capacitor and Cordova](./native-embed-component-plan.md) | One future PR for this plan                                       | Deferred until the persistence prerequisite passes.                      |
| [HTML editor and mieweb/ui integration](./html-embed-editor.md)                | One future PR for this plan                                       | Deferred until the persistence prerequisite passes.                      |

The two embedding tracks can run concurrently after the persistence prerequisite. Base their later PRs on the accepted persistence work; use dependent PRs if it has not yet merged. This PR includes embedding plans and prerequisites, with no embedding implementation.

## Validation record

The complete application source was validated at [738eed3](https://github.com/mieweb/pulse/commit/738eed3875fa2b72d5e2553f3773727d324ca727). Consolidation preserves that application source, `package.json` and `package-lock.json`; its subsequent changes update review documentation only.

Using Node 24.18.0:

- `npm test -- --runInBand`: 58 suites / 647 tests passed. One integration suite containing six tests was skipped locally.
- `npx tsc --noEmit`: passed.
- `npm run lint`: passed.
- `node scripts/gen-protocol-types.mjs --check`: passed.
- Changed-file Prettier checks: passed. Repository-wide formatting reports 87 unchanged existing files; those files are outside this change.

These are recorded results from the complete implementation, not a claim that source tests were rerun for the documentation consolidation. Documentation formatting and relative links are checked when consolidating the review.

Earlier iOS/Android Metro/Hermes exports verified JavaScript bundles. They do not verify installed native applications or filesystem durability.

## Remaining release evidence

The [implementation checklist](./sqlite-pulse-implementation-plan.md) governs acceptance. Installed-library migration, iOS/Android crash/relaunch and filesystem durability, protected-credential/network workflows, native archive workflows and large-media save/rebuild measurements remain open. A skipped integration suite is not a pass. Keep the retained legacy data and the complete canonical package while verification continues.

The persistence release gate must pass before either embedding implementation starts. Code review or merging this PR alone does not prove that gate.
