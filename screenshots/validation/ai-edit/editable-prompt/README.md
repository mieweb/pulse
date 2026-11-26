# Editable AI prompt verification

Captured on 2026-11-25 in a dedicated **iPhone 17 Pro / iOS 26.0 simulator**, using an isolated
synthetic project. The compatible integration is `7cf0425`, with the same final JavaScript and
configuration as the [phone build](../../../../docs/testing/ai-edit-phone-build.md).

| Evidence                                                           | Screenshot                         |
| ------------------------------------------------------------------ | ---------------------------------- |
| Original prompt prefilled, four presets, Reset and explicit Create | [Default](default.png)             |
| Preset selected and its instructions visible                       | [Highlights](highlights.png)       |
| Custom text with software keyboard and accessible Done button      | [Keyboard](keyboard.png)           |
| Updated app-visible test notes                                     | [Release notes](release-notes.png) |

Native accessibility queries and actions verified all four preset values and exclusive selected
states, manual editing, Reset, keyboard dismissal, no automatic start, prompt preservation after
the real native simulator-unavailable error, and last-used instructions after closing/reopening
and a full app relaunch. The ordinary release configuration hid the AI entry. All six exact notes
were checked, including scrolling the final note into view. No coordinate fallback was used.

The [sanitized report](simulator-report.json) records these checks and cleanup. The owned session
ended, host runner exited, simulator runner disappeared and its endpoint stopped. The fixture
prompt was restored to Default.

These checks do not establish physical VoiceOver behavior, real model generation, style quality,
offline completion or export. The separate phone handoff verified installation, launch and library
preservation without starting phone automation or capture. Earlier screenshots in the parent
directory describe the initial automatic-start MVP and remain historical evidence.
