# AI edit developer preview verification

The current [editable-prompt verification](editable-prompt/README.md) supersedes this initial
automatic-start screen. The evidence below records the first MVP handoff.

Captured on 2026-11-25 in a dedicated **iPhone 17 Pro / iOS 26.0 simulator**. The screenshots use
an isolated synthetic 16-second project, not a user's recording. The app is the compatible phone
integration described in the [handoff](../../../docs/testing/ai-edit-phone-build.md).

| Evidence                                            | Screenshot                                           |
| --------------------------------------------------- | ---------------------------------------------------- |
| Editor before the feature                           | [Before](before-editor.png)                          |
| Exact final JavaScript with the developer flag off  | [Ordinary release](ordinary-release-editor.png)      |
| Developer flag on; AI edit in the lower command row | [Developer editor](after-editor.png)                 |
| Native availability bridge and error/retry/back UI  | [Simulator-unavailable explanation](unavailable.png) |
| Exact installed-build notes, first portion          | [Release notes](release-notes.png)                   |
| Final notes scrolled into view                      | [Release notes, bottom](release-notes-bottom.png)    |

Native accessibility queries/taps verified the hidden/enabled action, the unavailable-model
message, Back and all six exact release-note strings. Scrolling used the accessible ScrollView;
no coordinate fallback was used. Simulator automation was stopped after the checks.

The simulator cannot verify phone model generation, semantic selection quality, thermal behavior,
offline exports or physical VoiceOver behavior. No such pass is claimed by these screenshots.
