// Transcript shapes shared by the database (`src/db`) and the transcription feature. They live in
// core so the database layer never imports a feature module.

/**
 * One word of a transcript. `t0`/`t1` are whisper.cpp timestamps in **centiseconds** (1/100s)
 * relative to the clip's audio start. Words drive word-level (karaoke) caption highlighting.
 */
export type TranscriptWord = { text: string; t0: number; t1: number };

/**
 * One transcribed line (caption cue). `t0`/`t1` are **centiseconds** relative to the clip's
 * audio start — divide by 100 for seconds when rendering. `words` (when present) carries the
 * per-word timing within the line; older stored rows may omit it and render line-level only.
 */
export type TranscriptLine = { text: string; t0: number; t1: number; words?: TranscriptWord[] };
