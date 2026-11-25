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

Source verification: 2,229 tests passed (8 opt-in integration tests skipped locally), all source
and embed TypeScript checks, lint, generated protocol check, and iOS/Android embed bundle checks
passed. CI also passed the pinned and npm-latest PulseVault integration jobs.

The owned automation session and runner were stopped and the task's simulator shut down after
verification. Existing simulators were preserved. Android native UI, VoiceOver audio and a fresh
signed archive were not exercised. No physical iOS device was used.
