/** Files captured by an in-flight Undo operation or archive must outlive asynchronous work. */
const holds = new Map<string, number>();

export function holdMediaPaths(paths: Iterable<string>): () => void {
  const captured = new Set(paths);
  for (const path of captured) holds.set(path, (holds.get(path) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const path of captured) {
      const remaining = (holds.get(path) ?? 1) - 1;
      if (remaining > 0) holds.set(path, remaining);
      else holds.delete(path);
    }
  };
}

export const isMediaHeld = (path: string): boolean => holds.has(path);
export const heldMediaPaths = (): ReadonlySet<string> => new Set(holds.keys());
