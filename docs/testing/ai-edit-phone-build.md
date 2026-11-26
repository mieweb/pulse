# AI editing phone test build

Updated on 2026-11-25: **Pulse 2.8.0 (1)**, editable-prompt integration `7cf0425`.
Installation and launch passed. The app was verified running and left open for testing.
Existing draft and segment metadata, persistent history and schema were unchanged. The device
guard returned `released`; no phone UI automation or screen sharing was started.

Start at **open a project → editor → AI edit** (the sparkle beside Export). The screen now opens
with editable instructions before anything runs. **Default** contains the original successful
editorial prompt. Try **Highlights**, **Work update** or **Story**, edit the text, or use **Reset to
default**. Tap **Create AI cut** to start. The last used instructions are saved locally and restored
after reopening or relaunching; closing without Create does not save edits.

A successful run opens a separate **AI cut** project in Timeline view. The original remains
available. Exact test notes are bundled under **About → Release notes**. Download a speech model
and prepare Apple Intelligence before testing offline.

## Source and phone compatibility

The feature is pushed on `ai-auto-edit`: `e3b99d5` implements the MVP, `fe06763` fixes cancellation
before native request registration, and `6ee6c27` adds editable prompts and styles. Source checks
ran against a clean checkout of `6ee6c27`, with its exact committed submodule pins. Unrelated
shared-workspace changes were preserved. The editable default plus the fixed native output rules
matches the original model instructions exactly. Each selection pass receives the same frozen
prompt; passage-ID validation and the 115-second output budget remain enforced.

The phone already has newer persistent-history and voiceover migrations than this feature
branch's base. Its deployment therefore uses the isolated local branch
`codex/ai-prompt-phone-test`, commit `7cf04259a3462be6d2b7bc6083bd6f88ce612775`, at
`/tmp/pulse-ai-phone-source`. That branch combines `646f309` and the toolbar integration
`d3a853e`, then applies this AI feature and editable-prompt update. It retains `0022_persistent_undo`,
`0023_voiceover_takes` and native editor `306ff1d`.

The compatible editor places AI edit in the lower command row; the feature branch's older editor
places it in the header. Both supply the same developer-gated callback and run the same AI flow.
Rebuild future phone updates from this compatible integration or a newer base, rather than
installing the feature branch's older migration ordering over this library.

The ready app is `/tmp/pulse-ai-prompt-phone-ready/Pulse.app`. It includes freshly compiled native AI
code, a bundled Hermes payload, the six exact test notes and `PULSE_DEVELOPER_BUILD=1`. App and
extension entitlements were preserved, and signatures verified. The simulator used the identical
JavaScript/config payload. The [sanitized handoff record](ai-edit-phone-handoff.json) records
source/build hashes and verification without device identifiers or library contents.

## Verification

- Clean feature branch: root, embed and client TypeScript; lint; protocol generation; both embed
  JavaScript bundles/dependency rules; changed-file formatting and whitespace all passed.
- Jest: **162 suites / 2,230 tests passed**; one opt-in PulseVault integration suite containing
  eight tests was skipped. No upload-integration pass is claimed.
- Fresh simulator and signed iPhone Release native builds passed, including the Foundation Models
  module, request-ID cancellation and editable-prompt bridge. The compatible staging source also
  passed TypeScript, lint and 47 focused AI/database tests.
- The exact final simulator payload hid the entry with the developer flag off. With it on, native
  accessibility navigation verified the original prefill, no automatic start, all four presets and
  selected states, manual edits, Reset, keyboard dismissal and saved prompts after Create/relaunch.
  Create reached the real simulator-unavailable explanation and retained the custom text. All six
  release notes were verified. [Editable-prompt screenshots and platform details](../../screenshots/validation/ai-edit/editable-prompt/README.md).
- A brief guarded installation privately backed up SQLite outside the repository. Every existing
  draft and segment metadata hash, persistent-history hash and schema version matched afterward.
  Launch and the running app were verified, then the device was released.

## Remaining phone acceptance

Compare Default, another preset and a custom instruction on the same real 8–12 minute English
talking-head recording. Check retained meaning, complete thoughts,
joins, editable source windows and actual exported duration below 120 seconds. Repeat after a
cold launch in airplane mode with Wi-Fi off and all assets local. Record transcription, selection
and export time separately, plus memory and thermal behavior. Test cancellation/backgrounding.

The physical installation does not establish the new styles' generation quality, native export behavior,
offline completion or VoiceOver navigation. This developer preview uses Apple's on-device passage
selector. OmniShotCut conversion and written summaries remain follow-up work in
[#341](https://github.com/mieweb/pulse/issues/341).
