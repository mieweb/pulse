# Undo Take recording position

[Issue #343](https://github.com/mieweb/pulse/issues/343) is verified on an iPhone 17 Pro
simulator running iOS 26.0. The test used a synthetic 25-second project and native accessibility
button actions. No physical device was accessed.

The project had an earlier-added take at 20 seconds. It opened at the exact editor anchor
5,123.75 ms; the playhead readout shows 5.1 seconds. Recording and then undoing another take
reproduced the old behavior and verified the repair:

| Check | Result |
| --- | --- |
| Before the repair | Undo jumped to 20.6 seconds, the retained take's end |
| After the repair | Undo returned to 5.1 seconds; the saved `record_start_ms` was exactly 5,123.75 |
| Immediate retake | Pressing Start again without seeking saved the same 5,123.75 ms origin |
| Reopen then Undo | Reopening at zero and undoing the saved retake returned to 5.1 seconds |
| Legacy take | A migrated null origin fell back to its saved audio start at 20 seconds |
| First take at zero | The saved origin was exactly zero; Undo returned to zero |

The fixed capture's native audio start was 5,123.752999790013 ms, while its original Record
position remained 5,123.75 ms. The retake also retained that exact origin independently of its
audio timing. The database verifies fractional precision; screenshots show the existing
0.1-second readout and the native player's displayed video frame.

[Before recording](../../screenshots/validation/voiceover-undo-position/before-record.png) ·
[Old Undo result](../../screenshots/validation/voiceover-undo-position/before-fix-undo.png) ·
[Fixed Undo result](../../screenshots/validation/voiceover-undo-position/after-fix-undo.png) ·
[Sanitized report and source hashes](../../screenshots/validation/voiceover-undo-position/report.json).
The accompanying XML snapshots record the native accessibility state.

The baseline JavaScript was the previously installed `4dbf8e7` build. The fixed run used fresh
JavaScript, assets, config and migration `0024` from this branch, compiled with Node 24.18.0 and
Hermes, in the previously verified native Release shell at `pulse-editor` commit `306ff1d`.
The native engine was reused; this check does not claim a new full native build. The report
records the tested bundle and relevant source hashes.

The flow used the existing accessible Start/Stop and Undo buttons. It changes the phone's Undo
behavior without changing control placement. Default text size was checked. Physical thumb
reach with either hand, large text/RTL, full screen-reader traversal and microphone/acoustic
hardware behavior were not retested. Save retry and immediate Undo while saving are source
regressions; the simulator sequence waited for each take to save before Undo.

The owned WebDriverAgent session was deleted, its host and simulator runner exited, and its
port closed. The synthetic project and its media were removed. All pre-existing draft, segment
and take column values matched the pre-test snapshot; migration only added nullable origin
metadata. The app was relaunched on Home after cleanup. No raw microphone files were copied
outside the simulator.
