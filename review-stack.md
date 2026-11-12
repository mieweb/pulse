# Canonical persistence review stack

This review stack separates the persistence work into changes that can merge in order. Each PR targets the branch immediately below it. Merge the planning PR into `main` first, then merge the three implementation layers from bottom to top. Rebase/retarget later PRs as earlier layers land. No layer authorizes embedding implementation or completes the native release gate.

| Order | Branch                               | Purpose                                                                                                                                                                  | State in this snapshot |
| ----: | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
|     1 | `codex/pulse-persistence-plan`       | Audit, canonical format/recovery contract, ordered checklist and dependent embedding plans. No production source change.                                                 | Present                |
|     2 | `codex/pulse-persistence-foundation` | Inactive typed document/codecs, complete SQLite adapters, repository/native storage, guard, bootstrap/recovery primitives and isolated tests.                            | Present                |
|     3 | `codex/pulse-persistence-runtime`    | Activate canonical saves and disposable-cache bootstrap together with migration retention, cleanup protections and save-error propagation. Existing transfer remains v1. | Present                |
|     4 | `codex/pulse-persistence-backup`     | Wire v2 transfer, exact archive restore, complete library export and backup UI.                                                                                          | Present                |

Current snapshot: **Complete transfer and backup**. This layer completes v2 portable sharing/copy import, the explicit full-library archive-restore API and the library-backup UI on top of the canonical runtime. Native crash/relaunch, durability, workflow and performance release checks remain open.

## Validation record

Record the actual layer commit, PR link, commands/results and skipped coverage here after validating each branch. The earlier all-in-one prototype commit `aa16e08` is reference material, not validation of a newly split branch. Source links marked as prototype point to that earlier commit when their files belong to a later layer.

| Layer      | Source commit / PR                       | Validation                                                                                                             | Remaining limits                                                                                                   |
| ---------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Planning   | 5ab436f23493fc74b3ef43d489ee8b134af720c4 | 40 suites / 464 tests pass; six integration tests skipped; typecheck, lint, protocol and changed-file formatting pass. | No application behavior changed.                                                                                   |
| Foundation | 29ab64dae79478e9e5efcabc5efe8578d3e3de7b | 51 suites / 609 tests pass; six integration tests skipped; typecheck, lint, protocol and changed-file formatting pass. | Modules remain inactive until runtime layer; native release checks open.                                           |
| Runtime    | 7e19ca248993ae492e497228816ee557218bddac | 55 suites / 633 tests pass; six integration tests skipped; typecheck, lint, protocol and changed-file formatting pass. | Native installed-library, process-kill/durability, secrets/network and performance checks open; transfer still v1. |
| Backup     | This PR                                  | 58 suites / 647 tests pass; six integration tests skipped; typecheck, lint, protocol and changed-file formatting pass. | Native archive workflows and large-media measurements remain open.                                                 |

Use Node 24 meeting `package.json`'s engine requirement. Run `npx tsc --noEmit`, `npm run lint`, `npm test -- --runInBand` and `node scripts/gen-protocol-types.mjs --check` on each implementation layer. Report skipped integration tests as skipped. An iOS/Android Metro/Hermes export is a bundle check, not a native application or physical durability test.

The [implementation checklist](./sqlite-pulse-implementation-plan.md) records the acceptance work. Its native release gate remains open after this stack; the [embedding plans](./native-embed-component-plan.md) remain dependent follow-up work.
