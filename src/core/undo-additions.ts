import type { Step } from './types/editor-history';

export type UndoStacks = { past: Step[]; future: Step[] };
type Owner = { snapshot(): UndoStacks; committed(history: UndoStacks): void };
const owners = new Map<string, Owner>();
const batches = new Map<string, Map<string, string>>();

/** The database can checkpoint an open editor without importing its React or native modules. */
export function registerUndoAdditionOwner(draftId: string, owner: Owner): () => void {
  owners.set(draftId, owner);
  return () => {
    if (owners.get(draftId) === owner) owners.delete(draftId);
  };
}
export const undoAdditionSnapshot = (draftId: string) => owners.get(draftId)?.snapshot();
export function acceptUndoAddition(draftId: string, history: UndoStacks): void {
  try {
    owners.get(draftId)?.committed(history);
  } catch (error) {
    console.warn('[undo] committed addition could not reach its editor', error);
  }
}

/** Image preparation identifies its batch before its row transaction, including under edits. */
export function markUndoAdditionBatch(draftId: string, clipId: string, key: string): void {
  let ids = batches.get(draftId);
  if (!ids) {
    ids = new Map();
    batches.set(draftId, ids);
  }
  ids.set(clipId, key);
}
export function undoAdditionBatch(draftId: string, ids: readonly string[]): string | undefined {
  const mapped = batches.get(draftId);
  const key = ids.length ? mapped?.get(ids[0]) : undefined;
  return key && ids.every((id) => mapped?.get(id) === key) ? key : undefined;
}
export function clearUndoAdditionBatch(draftId: string, key: string): void {
  const mapped = batches.get(draftId);
  if (!mapped) return;
  for (const [id, batch] of mapped) if (batch === key) mapped.delete(id);
  if (!mapped.size) batches.delete(draftId);
}
