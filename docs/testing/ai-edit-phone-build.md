# AI editing phone test build

Installed on 2026-11-25: **Pulse 2.8.0 (1)**, developer integration `e5e8069`.
Reinstalled and launched successfully after the initial lock-screen rejection. The app was
verified running and left open for testing. Library preservation passed and the device guard
returned `released`; no phone UI automation or screen sharing was started.

Start at **open a project → editor → AI edit** (the sparkle beside Export). A successful run opens
a separate **AI cut** project in Timeline view. The original remains available. Exact test notes
are bundled under **About → Release notes**. Download a speech model and prepare Apple
Intelligence before testing offline.

## Source and phone compatibility

The feature is pushed on `ai-auto-edit`: `e3b99d5` implements the MVP and `fe06763` fixes cancellation
before native request registration. Source checks ran against a clean checkout of `fe06763`, with
its exact committed submodule pins. Unrelated shared-workspace changes were preserved.

The phone already has newer persistent-history and voiceover migrations than this feature
branch's base. Its deployment therefore uses the isolated local branch
`codex/ai-auto-edit-phone-test`, commit `e5e80694145a6533c77bc42fc3d56256b1f403e5`, at
`/tmp/pulse-ai-phone-source`. That branch combines `646f309` and the toolbar integration
`d3a853e`, then applies this AI feature. It retains `0022_persistent_undo`,
`0023_voiceover_takes` and native editor `306ff1d`.

The compatible editor places AI edit in the lower command row; the feature branch's older editor
places it in the header. Both supply the same developer-gated callback and run the same AI flow.
Rebuild future phone updates from this compatible integration or a newer base, rather than
installing the feature branch's older migration ordering over this library.

The ready app is `/tmp/pulse-ai-phone-ready/Pulse.app`. It includes freshly compiled native AI
code, a bundled Hermes payload, the six exact test notes and `PULSE_DEVELOPER_BUILD=1`. App and
extension entitlements were preserved, and signatures verified. The simulator used the identical
JavaScript/config payload. The [sanitized handoff record](ai-edit-phone-handoff.json) records
source/build hashes and verification without device identifiers or library contents.

## Verification

- Clean feature branch: root, embed and client TypeScript; lint; protocol generation; both embed
  JavaScript bundles/dependency rules; changed-file formatting and whitespace all passed.
- Jest: **159 suites / 2,213 tests passed**; one opt-in PulseVault integration suite containing
  eight tests was skipped. No upload-integration pass is claimed.
- Fresh simulator and signed iPhone Release native builds passed, including the Foundation Models
  module and request-ID cancellation changes.
- The exact final simulator payload hid the entry with the developer flag off. With it on, native
  accessibility navigation reached AI edit, its expected simulator-unavailable explanation, Back
  and all six release notes. [Screenshots and platform details](../../screenshots/validation/ai-edit/README.md).
- A brief guarded installation privately backed up SQLite outside the repository. Every existing
  draft and segment metadata hash, persistent-history hash and schema version matched afterward.
  A subsequent guarded deployment verified launch and the running app, then released the device.

## Remaining phone acceptance

Use a real 8–12 minute English talking-head recording. Check retained meaning, complete thoughts,
joins, editable source windows and actual exported duration below 120 seconds. Repeat after a
cold launch in airplane mode with Wi-Fi off and all assets local. Record transcription, selection
and export time separately, plus memory and thermal behavior. Test cancellation/backgrounding.

The physical installation does not establish model generation quality, native export behavior,
offline completion or VoiceOver navigation. This first build uses Apple's on-device passage
selector. OmniShotCut conversion and written summaries remain follow-up work in
[#341](https://github.com/mieweb/pulse/issues/341).
