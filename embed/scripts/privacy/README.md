# Privacy manifests for PulseKit's frameworks

Apple's privacy report reads a `PrivacyInfo.xcprivacy` at the root of each framework an app
embeds. hermes and SDWebImage are on Apple's list of SDKs that must carry one, and the
expo-brownfield build leaves them out. `embed/scripts/package-ios.mjs` writes these files into
every kept slice of the matching xcframework (`lib/release-privacy.mjs` maps them), and checks
each one first (`privacyManifestProblems`).

| File                                     | Framework              | What it declares                         |
| ---------------------------------------- | ---------------------- | ---------------------------------------- |
| `SDWebImage.xcprivacy`                   | `SDWebImage.framework` | File timestamps, `C617.1` (its cache)    |
| `hermesvm.xcprivacy`                     | `hermesvm.framework`   | No required-reason APIs, no data, no ads |
| `rnwhisper.xcprivacy`                    | `rnwhisper.framework`  | No required-reason APIs, no data, no ads |
| `../../native/ios/PrivacyInfo.xcprivacy` | `PulseKit.framework`   | See below                                |

PulseKit's own manifest lives with the facade sources, because
`embed/plugins/with-pulsekit-facade.js` also copies it into the PulseKit target when the embed is
prebuilt.

## How the declarations were chosen

- **SDWebImage, hermesvm, rnwhisper:** from the symbols each binary imports
  (`nm -u <framework>/<binary>`) in the M1 build (SDWebImage and hermes from expo-brownfield's
  output, rnwhisper from whisper.rn 0.7.4). SDWebImage imports `NSURLContentModificationDateKey`,
  `NSURLContentAccessDateKey`, `NSURLCreationDateKey` and `NSURLAttributeModificationDateKey`
  for its disk cache. hermesvm and rnwhisper import none of the required-reason APIs
  (`mach_absolute_time`, `systemUptime`, `stat` and its relatives, `NSUserDefaults`, disk-space
  keys). Check again when one of them is upgraded.
- **PulseKit:** the union that `expo prebuild` aggregates for the embed host app from the pods
  linked into PulseKit (React Native, Expo modules, AsyncStorage): file timestamps (`C617.1`,
  `0A2A.1`, `3B52.1`), user defaults (`CA92.1`), system boot time (`35F9.1`) and disk space
  (`E174.1`, `85F4.1`; Pulse checks free space before writing a backup or an import, in
  `src/utils/disk-space.ts`).
- **Collected data:** none. PulseKit hands the finished video to the host app, which sends it.
  When PulseKit uploads videos itself (the PR2 outbox), add `NSPrivacyCollectedDataTypePhotosorVideos`
  and `NSPrivacyCollectedDataTypeAudioData` (purpose App Functionality) to PulseKit's manifest.
