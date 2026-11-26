# Appearance verification

Verified on 2026-11-25 using a dedicated iPhone 17 Pro simulator running iOS 26.0.
The current JavaScript bundle was exported into a copy of an existing simulator
native shell; native code was unchanged. Other simulator sessions and physical
devices were not used.

Home's appearance button now opens **System (device)**, **Always light**, and
**Always dark**. System is the default. Existing saved Light and Dark preferences
remain pinned until the user chooses System.

| Before                                       | After                                             |
| -------------------------------------------- | ------------------------------------------------- |
| [Auto cycling button](before-auto-light.png) | [System button](after-system-light.png)           |
|                                              | [Dark menu, System checked](after-menu-dark.png)  |
|                                              | [Light menu, Light checked](after-menu-light.png) |

The simulator checks activated controls through native accessibility labels and
states, with no coordinate fallback. The [verification record](verification.json)
contains 23 passing state/selection checks:

- With no `appearance.theme` row, Pulse started in System and mirrored device Dark.
- System followed device Light and Dark changes while the app remained open.
- [Locked Light](after-light-locked-device-dark.png) stayed light with device Dark,
  including device changes and app termination/relaunch.
- [Locked Dark](after-dark-locked-device-light.png) stayed dark with device Light,
  including device changes and app termination/relaunch.
- Returning from either pin to System immediately mirrored the opposite device
  appearance, continued following live changes, and persisted after relaunch.
- Each menu option was independently accessible, enabled and visible, with one
  checked radio option; Dismiss closed the menu without changing the choice.
  See the native trees for [System](after-menu-dark.xml),
  [Light](after-menu-light.xml), and [Dark](after-menu-dark-selected.xml).

The initial native check found that an accessible backdrop swallowed the menu
rows in the accessibility tree. The backdrop and menu were changed to siblings,
and the rebuilt final bundle passed all selector-only activation and checked-state
checks above. No coordinate fallback was used for the failed or repaired menu.

The JavaScript export command was:

```sh
npx expo export:embed --platform ios --dev false \
  --entry-file node_modules/expo-router/entry.js \
  --bundle-output /tmp/pulse-appearance-ui/Pulse.app/main.jsbundle \
  --assets-dest /tmp/pulse-appearance-ui/Pulse.app
```

After verification, the test saved System, restored simulator appearance to Light,
deleted its automation session, stopped its owned runner and shut down the
dedicated simulator. Physical devices were never attached.

Android UI, physical-device behavior, spoken VoiceOver announcements, and large
text layouts were not exercised in this check. The native accessibility-tree
checks establish control exposure and state, not spoken VoiceOver behavior.

## Source checks

PR checks were rerun on 2026-11-26 using Node 24.18.0 in an isolated checkout
based on `main` at `d68aab2`, with the repository's pinned submodules. The three
appearance source files still match the hashes in the simulator record above.

- `npm test -- --runInBand`: 170 suites and 2,504 tests passed; the opt-in
  PulseVault integration suite (8 tests) was skipped. This includes 17 appearance
  regressions for defaults, live device changes, locks, explicit host ownership,
  and the web platform's absent native appearance setter.
- `npm run lint`, `npm run check:embed`,
  `node scripts/gen-protocol-types.mjs --check`, changed-file Prettier checks,
  and `git diff --check` passed.
- `npx tsc --noEmit`, `npx tsc --noEmit -p embed`, and
  `npx tsc --noEmit -p embed/packages/pulse-embed` passed without exclusions.
