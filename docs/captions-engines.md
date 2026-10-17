# Captions engines: what runs today, and the plan for Apple's recogniser

_How on-device captions pick a speech model, the measurements behind that pick, and the design for
adding Apple's built-in recogniser on newer iPhones. The Apple part is a plan: nothing in it is built,
and none of its numbers come from a phone._

Date: 2026-10-15

---

## What ships in this branch

Captions are made per clip (`src/features/transcription/clip-queue.ts`): each recorded clip is
transcribed once, in its own time, and the draft's captions are composed from those transcripts
through the clips' edits (`compose.ts`). The model the user selects decides the engine for every clip.

| | iOS | Android |
|---|---|---|
| English | Parakeet TDT 0.6B v3 (q4_0, 339 MiB) | Parakeet TDT 0.6B v3 |
| Any language | Whisper Large v3 Turbo (q5_0, 574 MiB), on the GPU | Whisper Small (q5_1, 181 MiB), provisional |

All of them run through whisper.rn 0.7.4 (whisper.cpp 1.9.3). The menu is per platform in
`models.ts` (`modelsFor`, `resolveSelectedModel`). The Android pick is provisional: none of these
models has been timed on an Android phone yet (see [Android](#android-waiting-for-a-device)).

Licences: whisper.rn, whisper.cpp and the Whisper weights are MIT. Parakeet's weights are NVIDIA's
under CC BY 4.0; ggml-org's GGUF conversion is labelled MIT, but a conversion can't change the
weights' licence, so the app credits NVIDIA and the licence in the On-device AI sheet.

## Measurements

Speech drafts in `.devrun/whisper/` (git-excluded; runbook in its README). Error rates are against
the videos' human captions, per clip and summed; word onset is against Vosk's word times (a model's
too, not ground truth).

- English: NASA "#AskNASA" (10 clips, 201 s; the `+ s8` dev draft).
- Spanish: NASA en Español, 22 clips. Mandarin: a TEDxTaipei talk, 14 clips (Traditional captions,
  scored as Simplified characters). Arabic: one talk's first ~5 minutes.

Accuracy (Mac, whisper.cpp 1.9.3 with the app's settings; Apple's on macOS 26.5):

| Engine | English WER | Spanish WER | Mandarin CER | Arabic WER |
|---|---|---|---|---|
| Parakeet TDT 0.6B v3 | 6.9% | 91.6% (translated to English) | 100% | not run |
| Whisper Large v3 Turbo | 5.7% | 1.9% | 3.8% | 17.5% |
| Whisper Small | 6.6% | 4.2% | 4.9% | 23.6% |
| Apple SpeechAnalyzer (locale given) | 7.3% | 2.9% | 2.7% | no locale |

- Word timing: Parakeet's word onsets sit a median 52 ms from Vosk's. Apple's land early (a −138 ms
  bias, 120 ms median distance).
- Parakeet v3 is multilingual as NVIDIA ships it, but whisper.cpp runs it as English only: a Spanish
  clip came back as an English translation, at q4_0 and q8_0 alike.

Speed (iPhone 17 Pro Max, whisper.rn, measured with the git-excluded `src/app/bench-captions.tsx`):

- Parakeet: 2.8 s for the 201 s English draft.
- Spanish set on the GPU (Metal): Small 13.4× realtime, Large Turbo 5.0×.
- With Core ML encoders instead (whisper.rn only uses Core ML with the GPU off): Small 5.7×,
  Large Turbo 3.5×, and about 2.4 minutes to compile the encoder on first use. The app stays on the GPU.

Language detection: Whisper tiny (31 MB) named the language right on all 46 multilingual clips, even
from each clip's first 5 seconds (Mac).

Ruled out for now: distil-small.en and Moonshine (less accurate than what ships); ML Kit's GenAI
speech API (alpha, no word timestamps); vendor-licensed or paid SDKs; and cloud services, since
captions stay on the phone. sherpa-onnx (Apache-2.0) matched Parakeet in English (6.9% WER, 50 ms
onset, ~32× realtime on the Mac CPU) but drifted into English on 8 of 22 Spanish clips, and its React
Native binding has an open Expo / New Architecture iOS issue: an Android English fallback at most.

## Plan: Apple's recogniser on iOS 26+ (not built)

`SpeechAnalyzer` with `SpeechTranscriber` (iOS 26) needs no download from us, and in Spanish and
Mandarin it was close to Large Turbo on the Mac. Its limits shape the design:

- **Hardware-gated.** `SpeechTranscriber.isAvailable` is false on some iOS 26 devices; those keep the
  whisper.rn models.
- **It needs the language.** There's no detection: the caller passes a locale.
- **About ten languages.** de, en, es, fr, it, ja, ko, pt, yue, zh (with regional variants, macOS 26.5
  list). Arabic, for one, isn't there.
- **Early word times.** About 140 ms early against Vosk; shift the words later before composing.

Design, per clip:

1. **Detect the language** with Whisper tiny (31 MB, downloaded with the feature) on the clip's first
   few seconds, already decoded at 16 kHz by `extractAudio`.
2. **Pick the engine:**
   - English: Parakeet (the best word timing), or Apple's when no model is downloaded.
   - A language Apple's locale list has: Apple's.
   - Anything else: Large Turbo.
3. **Chinese script.** Pick Simplified or Traditional from the phone's preferred languages
   (zh-Hans vs zh-Hant, zh-TW, zh-HK), not from the audio. The audio doesn't say which script the
   viewer reads.
4. **Store it like any other transcript.** The words go in `clip_transcripts`, keyed by an engine id
   (for example `apple-<locale>`), in file-time centiseconds, so compose and edits work unchanged.

To build: a small native module, Swift on iOS 26+, taking a file or PCM buffer plus a locale and
returning timed words; detection through whisper.rn; and the selection rules above in the clip
queue. To check on a phone before shipping: accuracy against the Mac numbers, speed, the
first-use asset download (Apple downloads the locale's model through `AssetInventory`), and the
onset shift.

## Android (waiting for a device)

Before the Android pick is final:

- Time Parakeet, Small and Large Turbo with whisper.rn on the CPU (whisper.rn has no Android GPU
  backend).
- Try `android.speech`'s on-device recogniser for word timing and accuracy, or rule it out.
- Keep sherpa-onnx Parakeet as the English fallback if whisper.rn's Parakeet is too slow.
