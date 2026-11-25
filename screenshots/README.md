# Store screenshots

Release screenshot sets for Pulse v2.0, captured with the dev-seed fixtures
(Big Buck Bunny, CC-BY 3.0) and demo-mode status bars. Both platforms use the
same 13-shot run sheet and shared `01-…13-` naming.

## Layout

| Directory | Contents |
| --- | --- |
| `ios/` | Raw captures — iPhone 17 Pro Max, 1320×2868 (exact App Store 6.9" spec) |
| `android/` | Raw captures — 720×1600 (⚠️ 1:2.22 aspect exceeds Play's 2:1 limit; upload the framed set instead) |
| `store/appstore/` | Framed marketing shots, 1284×2778 PNG, no alpha — upload-ready for App Store Connect |
| `store/playstore/` | Framed marketing shots, 1080×1920 (9:16) PNG, no alpha — upload-ready for Play Console |
| `frame/` | The framing script (see below) |

## Shots

| # | File | Caption |
| --- | --- | --- |
| 01 | `01-home-dark.png` | All your drafts, ready when you are |
| 02 | `02-recorder.png` | Record multi-clip videos fast |
| 03 | `03-clip-editor.png` | Tap any clip to preview it |
| 04 | `04-edit-clip-trim.png` | Trim right on device |
| 05 | `05-vault-pair-confirm.png` | Pair with your server securely |
| 06 | `06-vault-connected.png` | Connected to your private vault |
| 07 | `07-export-select.png` | Pick drafts to export |
| 08 | `08-home-light.png` | Light or dark — your call |
| 09 | `09-merging.png` | Merge clips into one video |
| 10 | `10-merged-share.png` | Share, save, or upload |
| 11 | `11-upload-complete.png` | Upload straight to your vault |
| 12 | `12-on-device-ai-models.png` | On-device AI — nothing leaves your phone |
| 13 | `13-captions-editor.png` | Word-by-word caption editing |

## Regenerating the framed sets

Requires Node >= 24 (`sharp` needs >= 20.9.0).

```sh
cd screenshots/frame
npm ci
npm run frame
```

The script composites each raw capture into a generic rounded-corner bezel with
a soft shadow, caption, and brand-tinted gradient background, then flattens to
alpha-free PNG at the exact store dimensions. The caption sits in a band above
the device, and the device is sized so the full screenshot stays visible on
both canvases. Generic bezels are deliberate: neither capture device has
official frame art, and stores accept (and expect) stylized marketing frames.
Captions live in the `CAPTIONS` map in [frame.mjs](frame/frame.mjs).

## Version screen verification (2026-11-25)

Native iPhone 16e simulator, iOS 26.0. The current source's JavaScript, assets and Expo config
were bundled into an existing release simulator shell with the existing iOS startup repair;
this verifies the native UI, rather than a fresh native archive. The baseline uses the same
About screen as `cf6771c`, with older build metadata.

| Capture | Result |
| --- | --- |
| [Before](validation/version-release-notes/before-about.png) | Original version/About screen |
| [Current build](validation/version-release-notes/after-about.png) | Complete bundled release notes and Release history action |
| [History](validation/version-release-notes/after-history-top.png) | Previous versions with calendar dates and summaries |
| [History end](validation/version-release-notes/after-history-bottom.png) | Fifth previous release reachable by scrolling |
| [Large text](validation/version-release-notes/large-about.png) | History action wraps at the largest accessibility text size |
| [Large history](validation/version-release-notes/large-history-top.png) | Notes wrap and scroll at the largest accessibility text size |

WDA checks used native accessibility labels/roles and native ScrollView scrolling, with no
coordinate actions. Current notes, all five earlier releases, closing history back to About,
and closing About back to drafts passed at default and largest Dynamic Type. Compatibility,
backup, logs and issue controls remain reachable by scrolling. VoiceOver audio, Android UI and
a fresh signed archive were not tested.

The same JavaScript bundle and current Expo config were subsequently signed into an unchanged
native device shell and installed on the user's iPhone 17 Pro. Installation and launch were
verified, and the deployment session was released before handoff. The user approved merging
after this device handoff. The existing scene lifecycle startup repair belongs to the native
shell and is outside this feature's source changes.

Source verification: `npx tsc --noEmit`, `npm run lint`, `npm test -- --runInBand`
(149 suites / 2,108 tests passed; server integration suite skipped),
`node scripts/gen-protocol-types.mjs --check`, and `npx expo config --json` passed.
Changed source files pass Prettier; the workflows retain their pre-existing YAML formatting.
Git fixtures cover exact build commits, adjacent release ranges, missing merge summaries,
unrelated tags and unavailable/shallow history.

## Store size cheat sheet

- **App Store Connect**: 6.5" display — 1284×2778 portrait. App Store Connect
  reuses this single set for all other iPhone display sizes unless overridden.
- **Play Console**: phone screenshots 1080×1920 (9:16); each side 320–3840 px,
  aspect ratio at most 2:1, PNG/JPEG ≤ 8 MB, no alpha. Feature graphic
  (1024×500) is required for store listing promotion and is not generated here.
