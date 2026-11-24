/**
 * The draft a recorder session adds to, made on first need: `current()` while there is one, else
 * `create()` (which makes it current before it resolves). A take, an import, a batch of images or
 * a copy each hold this from the render they started in; calls while one is making the draft wait
 * for that one, so the session gets one draft. A failed `create` is tried again on the next call.
 */
export function draftOnDemand(
  current: () => string | null,
  create: () => Promise<string>,
): () => Promise<string> {
  let creating: Promise<string> | null = null;
  return () => {
    const id = current();
    if (id) return Promise.resolve(id);
    creating ??= create().finally(() => {
      creating = null;
    });
    return creating;
  };
}
