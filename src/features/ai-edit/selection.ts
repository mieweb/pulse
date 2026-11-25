import { AI_CUT_MAX_DURATION_MS, fitPassageSelection, type AiEditPassage } from './planner';

type Select = (
  passages: { id: string; text: string; durationMs: number }[],
  targetDurationMs: number,
) => Promise<{ selectedIds: string[] }>;

// Leave room for the native instructions and structured-output schema in the local model.
const MAX_PASSAGES = 24;
const MAX_CHARACTERS = 7000;

export function passageBatches(passages: readonly AiEditPassage[]): AiEditPassage[][] {
  const batches: AiEditPassage[][] = [];
  let batch: AiEditPassage[] = [];
  let characters = 0;
  for (const passage of passages) {
    const size = passage.text.length + passage.id.length * 2 + 80;
    if (size > MAX_CHARACTERS)
      throw new Error('A spoken passage is too long to edit. Try a shorter source clip.');
    if (batch.length && (batch.length === MAX_PASSAGES || characters + size > MAX_CHARACTERS)) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(passage);
    characters += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('AI edit cancelled.');
}

/** Shortlist across chunks, then make one global editorial choice from the actual source text. */
export async function selectCut(
  passages: readonly AiEditPassage[],
  select: Select,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
) {
  let candidates = [...passages];
  if (!candidates.length) throw new Error('No timed speech was found in this project.');
  for (let round = 0; round < 4; round++) {
    checkCancelled(signal);
    const batches = passageBatches(candidates);
    const totalMs = candidates.reduce((total, passage) => total + passage.durationMs, 0);
    const shortlisted = new Set<string>();
    for (const [index, batch] of batches.entries()) {
      checkCancelled(signal);
      onProgress(
        batches.length === 1
          ? 'Choosing the final cut…'
          : `Finding the key passages… ${index + 1} of ${batches.length}`,
      );
      const batchMs = batch.reduce((total, passage) => total + passage.durationMs, 0);
      // Oversample each chunk; the final pass can spend the budget wherever the key ideas occur.
      const targetMs =
        batches.length === 1
          ? AI_CUT_MAX_DURATION_MS - 5000
          : Math.min(
              AI_CUT_MAX_DURATION_MS,
              Math.max(30_000, Math.round((2 * AI_CUT_MAX_DURATION_MS * batchMs) / totalMs)),
            );
      const result = await select(
        batch.map(({ id, text, durationMs }) => ({ id, text, durationMs })),
        targetMs,
      );
      checkCancelled(signal);
      // A chunk containing only tangents may contribute no passages. The global pass must
      // still produce a real selection; no heuristic cut replaces a failed model response.
      if (batches.length > 1 && result.selectedIds.length === 0) continue;
      // Validate and fit complete passages, including padding. The model only supplies IDs.
      const plan = fitPassageSelection(batch, result.selectedIds, {
        maxDurationMs: batches.length === 1 ? AI_CUT_MAX_DURATION_MS : targetMs,
      });
      if (batches.length === 1) return plan;
      plan.selectedPassageIds.forEach((id) => shortlisted.add(id));
    }
    const next = candidates.filter((passage) => shortlisted.has(passage.id));
    if (!next.length)
      throw new Error('The AI did not find passages to retain. Try the edit again.');
    if (next.length >= candidates.length)
      throw new Error('The AI could not narrow this recording. Try the edit again.');
    candidates = next;
  }
  throw new Error('This recording needs a shorter source clip for the AI editing experiment.');
}
