/**
 * Tracks whether a kind of screen is mounted, so navigation can wait for one to be gone: a
 * dismissed native-stack screen stays mounted until its closing animation ends, and pushing a
 * screen meanwhile (a second camera, a route over a closing sheet) is what goes wrong.
 */
export function createPresence() {
  let count = 0;
  let waiters: (() => void)[] = [];
  return {
    /** Marks one mounted; call the returned function when it unmounts (once). */
    enter(): () => void {
      count += 1;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        count -= 1;
        if (count > 0) return;
        const done = waiters;
        waiters = [];
        for (const resolve of done) resolve();
      };
    },
    /** Resolves once none is mounted, or after `timeoutMs` at the latest. */
    whenGone(timeoutMs: number): Promise<void> {
      if (count === 0) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}
