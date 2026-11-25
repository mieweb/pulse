/** Export/backup waits for editor checkpoints without importing the editor or opening it. */
const writers = new Set<() => Promise<void>>();

export function registerUndoWriter(write: () => Promise<void>): () => void {
  writers.add(write);
  return () => {
    writers.delete(write);
  };
}

export async function waitForUndoHistory(): Promise<void> {
  await Promise.all([...writers].map((write) => write()));
}
