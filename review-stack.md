# Canonical persistence review stack

This review stack separates the persistence work into changes that can merge in order. Each PR targets the branch immediately below it. Merge the planning PR into `main` first, then merge the three implementation layers from bottom to top. Rebase/retarget later PRs as earlier layers land. No layer authorizes embedding implementation or completes the native release gate.

| Order | Branch                               | Purpose                                                                                                                                                                  | State in this snapshot |
| ----: | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
|     1 | `codex/pulse-persistence-plan`       | Audit, canonical format/recovery contract, ordered checklist and dependent embedding plans. No production source change.                                                 | Present                |
|     2 | `codex/pulse-persistence-foundation` | Inactive typed document/codecs, complete SQLite adapters, repository/native storage, guard, bootstrap/recovery primitives and isolated tests.                            | Later layer            |
|     3 | `codex/pulse-persistence-runtime`    | Activate canonical saves and disposable-cache bootstrap together with migration retention, cleanup protections and save-error propagation. Existing transfer remains v1. | Later layer            |
|     4 | `codex/pulse-persistence-backup`     | Wire v2 transfer, exact archive restore, complete library export and backup UI.                                                                                          | Later layer            |

Current snapshot: **Planning only**. This layer contains plans and repository requirements only. It does not change production persistence. SQLite and the v1 transfer format remain the application baseline; the architecture below is the planned target.

## Validation record

Record the actual layer commit, PR link, commands/results and skipped coverage here after validating each branch. The earlier all-in-one prototype commit `aa16e08` is reference material, not validation of a newly split branch. Source links marked as prototype point to that earlier commit when their files belong to a later layer.

| Layer      | Source commit / PR        | Validation                                                                                                             | Remaining limits                                                                                                   |
| ---------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Planning   | This PR                   | 40 suites / 464 tests pass; six integration tests skipped; typecheck, lint, protocol and changed-file formatting pass. | No application behavior changed.                                                                                   |
| Foundation | Pending stack publication | TypeScript, lint, Jest and protocol checks pending                                                                     | Modules remain inactive until runtime layer; native release checks open.                                           |
| Runtime    | Pending stack publication | TypeScript, lint, Jest and protocol checks pending                                                                     | Native installed-library, process-kill/durability, secrets/network and performance checks open; transfer still v1. |
| Backup     | Pending stack publication | TypeScript, lint, Jest and protocol checks pending                                                                     | Native archive workflows and large-media measurements remain open.                                                 |

Use Node 24 meeting `package.json`'s engine requirement. Run `npx tsc --noEmit`, `npm run lint`, `npm test -- --runInBand` and `node scripts/gen-protocol-types.mjs --check` on each implementation layer. Report skipped integration tests as skipped. An iOS/Android Metro/Hermes export is a bundle check, not a native application or physical durability test.

The [implementation checklist](./sqlite-pulse-implementation-plan.md) records the acceptance work. Its native release gate remains open after this stack; the [embedding plans](./native-embed-component-plan.md) remain dependent follow-up work.
