/**
 * The editor owns its asynchronous edit queue; storage waits for that queue before inserting
 * clips without importing a feature. In a recorder with no editor loaded there is no queue.
 */
let flush = () => Promise.resolve();

export function setClipWriteBarrier(next: () => Promise<void>): () => void {
  const previous = flush;
  flush = next;
  return () => {
    if (flush === next) flush = previous;
  };
}

export const waitForClipWrites = () => flush();
