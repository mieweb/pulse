# Captions engines: what runs today, and the plan for Apple's recogniser

_How on-device captions pick a speech model, the measurements behind that pick, and the design for
adding Apple's built-in recogniser on newer iPhones. The Apple part is a plan: nothing in it is built,
and none of its numbers come from a phone._

Date: 2026-10-15

References clarified on 2026-11-26; the measurements below are unchanged. These speech engines
supply timed words to the [offline AI editing pipeline](ai-editing.md). The planned Apple speech
recognizer here is separate from the Apple on-device language model already used to select passages.

---

## What ships in this branch

Captions are made [per clip](../src/features/transcription/clip-queue.ts). A valid transcript is
[cached by clip/model](../src/db/clip-transcripts.ts#L60) and
[matched to its source file](../src/features/transcription/compose.ts#L31); missing or stale entries
need recognition, and failed entries need a retry. Words keep the file's own time, and the draft's captions
are composed through the clips' edits ([compose.ts](../src/features/transcription/compose.ts)).
The model the user selects decides the engine for every clip.

|              | iOS                                                                                                        | Android                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| English      | [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (q4_0, 339 MiB)                 | Parakeet TDT 0.6B v3                                                                      |
| Any language | [Whisper Large v3 Turbo](https://huggingface.co/openai/whisper-large-v3-turbo) (q5_0, 574 MiB), on the GPU | [Whisper Small](https://huggingface.co/openai/whisper-small) (q5_1, 181 MiB), provisional |

All of them run through [whisper.rn 0.7.4](https://github.com/mybigday/whisper.rn/tree/v0.7.4)
([whisper.cpp 1.9.3](https://github.com/ggml-org/whisper.cpp/tree/v1.9.3)). The actual quantized
files, exact byte counts and platform menu (`modelsFor`, `resolveSelectedModel`) are in
[models.ts](../src/features/transcription/models.ts). The table uses the catalog's approximate
size labels. Parakeet uses [ggml-org's conversion](https://huggingface.co/ggml-org/parakeet-GGUF).
Pulse's [local binding patch](../patches/whisper.rn+0.7.4.patch) exposes Parakeet's word timing.
The Android pick is provisional: none of these
models has been timed on an Android phone yet (see [Android](#android-waiting-for-a-device)).

Licences: [whisper.rn](https://github.com/mybigday/whisper.rn/blob/v0.7.4/LICENSE),
[whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/v1.9.3/LICENSE) and
[Whisper's code and weights](https://github.com/openai/whisper#license) are MIT. Parakeet's
[NVIDIA model terms](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3#licenseterms-of-use) specify
CC BY 4.0. The GGUF conversion card is labelled MIT, but the app retains NVIDIA's weight attribution
and licence in the [On-device AI sheet](../src/features/transcription/on-device-ai-sheet.tsx).

## Measurements

The numbers in this section are the reported results in the
[original 2026-10-15 experiment record](https://github.com/mieweb/pulse/blob/ff4cf09c5b398128e78c2dd97a4f92d80df6b73c/docs/captions-engines.md#measurements),
not new measurements. That record describes local speech drafts and a runbook under
`.devrun/whisper/`, outside the committed experiment files. Error rates are against the videos'
human captions, per clip and summed; word onset is against [Vosk](https://github.com/alphacep/vosk-api)'s
word times (a model's too, not ground truth).

- English: NASA "#AskNASA" (10 clips, 201 s; the `+ s8` dev draft). The
  [source-video listing from NASA](https://www.nasa.gov/stem-content/how-to-be-an-astronaut/)
  includes "#AskNASA: How Can I Be An Astronaut?"; the
  [fixture generator](../scripts/make-speech-fixtures.py) records its exact YouTube ID.
- Spanish: NASA en Español, 22 clips. Mandarin: a TEDxTaipei talk, 14 clips (Traditional captions,
  scored as Simplified characters). Arabic: one talk's first ~5 minutes.

The English [clips](../assets/dev/speech/), [human captions](../assets/dev/speech/asknasa.en.json3)
and [source cut windows](../assets/dev/speech/cuts.json) are committed and inspectable. The cut
windows total 201.43 seconds, consistent with the rounded 201 seconds above. The multilingual
source URLs, raw scoring outputs, local runbook and phone benchmark script were not committed
with the original note and are not available in this checkout. Those results cannot be fully
reproduced from the versioned record alone.

Accuracy (Mac, whisper.cpp 1.9.3 with the app's settings; Apple's on macOS 26.5):

| Engine                              | English WER | Spanish WER                   | Mandarin CER | Arabic WER |
| ----------------------------------- | ----------- | ----------------------------- | ------------ | ---------- |
| Parakeet TDT 0.6B v3                | 6.9%        | 91.6% (translated to English) | 100%         | not run    |
| Whisper Large v3 Turbo              | 5.7%        | 1.9%                          | 3.8%         | 17.5%      |
| Whisper Small                       | 6.6%        | 4.2%                          | 4.9%         | 23.6%      |
| Apple SpeechAnalyzer (locale given) | 7.3%        | 2.9%                          | 2.7%         | no locale  |

- Word timing: Parakeet's word onsets sit a median 52 ms from Vosk's. Apple's land early (a −138 ms
  bias, 120 ms median distance).
- Parakeet v3 is multilingual as NVIDIA ships it, but the whisper.cpp 1.9.3 experiment produced
  English only: a Spanish clip came back as an English translation, at q4_0 and q8_0 alike.

Speed (iPhone 17 Pro Max, whisper.rn, reported in the original record using the uncommitted
`src/app/bench-captions.tsx`):

- Parakeet: 2.8 s for the 201 s English draft.
- Spanish set on the GPU (Metal): Small 13.4× realtime, Large Turbo 5.0×.
- With Core ML encoders instead (whisper.rn only uses Core ML with the GPU off): Small 5.7×,
  Large Turbo 3.5×, and about 2.4 minutes to compile the encoder on first use. Pulse
  [requests the GPU on iOS, with a CPU fallback](../src/features/transcription/whisper.ts#L49)
  if context loading fails.

Language detection: Whisper tiny (31 MB) named the language right on all 46 multilingual clips, even
from each clip's first 5 seconds (Mac).

Ruled out in that comparison: distil-small.en and Moonshine (less accurate than what ships);
[ML Kit's GenAI speech API](https://developers.google.com/ml-kit/genai/speech-recognition/android)
(alpha, no word timestamps in that evaluation); vendor-licensed or paid SDKs; and cloud services,
since captions stay on the phone. [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0)
matched Parakeet in English (6.9% WER, 50 ms onset, ~32× realtime on the Mac CPU) but drifted into
English on 8 of 22 Spanish clips. Its React Native binding was also ruled out for iOS over an
Expo / New Architecture issue; no issue URL was recorded, so recheck that limitation before
using it as a current blocker. It remains a candidate Android English fallback.

## Plan: Apple's recogniser on iOS 26+ (not built)

[SpeechAnalyzer](https://developer.apple.com/documentation/speech/speechanalyzer) with
[SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber) (iOS 26)
uses Apple-managed speech assets rather than models distributed by Pulse. Initial assets may
still need a download through [AssetInventory](https://developer.apple.com/documentation/speech/assetinventory).
In the recorded Spanish and Mandarin comparison it was close to Large Turbo on the Mac.
Its limits shape the design:

- **Hardware-gated.** Check [SpeechTranscriber.isAvailable](https://developer.apple.com/documentation/speech/speechtranscriber/isavailable)
  on the target device; unsupported devices keep the whisper.rn models.
- **It needs the language.** The [initializer](https://developer.apple.com/documentation/speech/speechtranscriber/init%28locale%3Apreset%3A%29)
  takes a locale; this plan supplies detection separately.
- **Locale-limited.** The experiment's macOS 26.5 list had about ten languages: de, en, es, fr, it,
  ja, ko, pt, yue, zh (with regional variants). Arabic was absent from that list. Query
  [supportedLocales](https://developer.apple.com/documentation/speech/speechtranscriber/supportedlocales)
  at runtime rather than treating that historical list as fixed.
- **Early word times in this experiment.** About 140 ms early against Vosk; verify the proposed
  shift later on a phone before changing caption composition.

Design, per clip:

1. **Detect the language** with Whisper tiny (31 MB, downloaded with the feature) on the clip's first
   few seconds, using the existing [16 kHz mono PCM extraction](../src/features/transcription/whisper.ts#L101).
2. **Pick the engine:**
   - English: Parakeet (the best word timing), or Apple's when no model is downloaded.
   - A language Apple's locale list has: Apple's.
   - Anything else: Large Turbo.
3. **Chinese script.** Pick Simplified or Traditional from the phone's preferred languages
   (zh-Hans vs zh-Hant, zh-TW, zh-HK), not from the audio. The audio doesn't say which script the
   viewer reads.
4. **Store it like any other transcript.** The words go in the existing
   [clip_transcripts table](../src/db/schema.ts#L202-L215), keyed by an engine id
   (for example `apple-<locale>`) and clip, with its source file. Use the current
   [file-time centisecond word type](../src/core/types/transcription.ts), so compose and edits work
   unchanged.

To build: a small native module, Swift on iOS 26+, taking a file or PCM buffer plus a locale and
returning timed words; detection through whisper.rn; and the selection rules above in the clip
queue. To check on a phone before shipping: accuracy against the Mac numbers, speed, the
first-use asset download (Apple downloads the locale's model through `AssetInventory`), and the
onset shift.

## Android (waiting for a device)

Before the Android pick is final:

- Time Parakeet, Small and Large Turbo with whisper.rn on the CPU (whisper.rn has no Android GPU
  backend).
- Try Android's [SpeechRecognizer on-device APIs](https://developer.android.com/reference/android/speech/SpeechRecognizer)
  for word timing and accuracy, or rule them out.
- Keep sherpa-onnx Parakeet as the English fallback if whisper.rn's Parakeet is too slow.
