# Persistent Undo verification — 2026-11-25

Native iOS 26.0 simulator with a dedicated synthetic library. JavaScript at `c78e431`
(application sources unchanged by the test-only commit `babd75d`) was bundled into a copied
Release simulator shell. The native engines are unchanged by this PR. This was not a fresh
native archive or a physical-device test.

Native accessibility labels and roles drove the checks:

- Flip, Rotate and Undo left both stacks available after closing/reopening the editor and
  restarting the app/simulator.
- A clip copied through Other Pulse was undone to an empty draft, then restored after restart
  through Home → recorder → Edit → Redo.
- The empty draft was exported through the native share sheet and Save to Files, then imported
  through the native document picker under fresh draft/clip IDs and media paths. Imported
  Undo/Redo left the original empty draft and its retained Redo unchanged.
- SQLite and filesystem observations confirmed rows, edit settings, caption edits, both stacks
  and media availability. Transcript retention is covered by the automated SQLite/archive
  regressions; native transcript rows were not separately queried.

| Capture                                           | Result                                                      |
| ------------------------------------------------- | ----------------------------------------------------------- |
| [Empty recorder](empty-recorder-edit.png)         | An empty draft retained for Redo exposes Edit after restart |
| [Before Redo](empty-editor-redo.png)              | Reopened empty editor offers Redo                           |
| [After Redo](addition-restored-after-restart.png) | The actual copied clip is restored after restart            |
| [Imported copy](imported-copy-redone.png)         | Redo restores the imported copy without changing its source |

## Closed-editor addition follow-up

A fresh synthetic library included main's summary migration `0021` and Undo migration `0022`.
At `e7b4fc3`, the editor was closed through Home, then the recorder added a synthetic donor clip
through **Add a clip → Other Pulse** without reopening the editor. The saved prior Undo prefix
was unchanged, old Redo cleared, and one new addition step could be undone.

After a full simulator restart with JavaScript at `390ac28`, both stacks hydrated, Redo restored
the third clip, and Undo of that addition followed by Undo of the earlier edit both succeeded.
The intervening change adds an earlier held-file cleanup guard and formatting; both runs used
the same fresh schema. This checks the recorder's import path, without camera capture.

| Capture                                          | Result                                                |
| ------------------------------------------------ | ----------------------------------------------------- |
| [Before Redo](recorder-addition-before-redo.png) | Two clips and both saved stacks survive restart       |
| [After Redo](recorder-addition-after-redo.png)   | Redo restores the recorder addition as the third clip |

Current source verification at `390ac28`: 2,289 tests passed (8 opt-in integration tests skipped
locally), all source and embed TypeScript checks, lint, generated protocol check, changed-file
formatting and iOS/Android embed bundle checks passed. CI also passed the pinned and npm-latest
PulseVault integration jobs. Native `.pulse` share/import was verified at `c78e431` above and was
not repeated in this focused follow-up.

The owned automation session and runner were stopped and the task's simulator shut down after
verification. Existing simulators were preserved. Android native UI, VoiceOver audio and a fresh
signed archive were not exercised. The reused shell also does not verify main's newer iOS 27
scene lifecycle/startup configuration. No physical iOS device was used.
