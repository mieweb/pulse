/** Leave five seconds of export headroom beneath the two-minute product limit. */
export const AI_CUT_MAX_DURATION_MS = 115_000;

/** File-relative milliseconds resolved from known transcript passages, never model-generated times. */
export type AiEditInterval = {
  segmentId: string;
  file: string;
  sourceKey: string;
  startMs: number;
  endMs: number;
};
