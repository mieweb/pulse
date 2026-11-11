import type { DraftContext } from '@/db/drafts';
import type { RecorderPlace } from '@/features/recorder/link-place';

/**
 * The recorder a link that names a place opens: on that place's open draft, else a new one named
 * with the link's `name` (none when it has no name). `opened` hears which; `failed` that it
 * couldn't be opened at all.
 */
export type RecorderTarget = {
  server: string;
  ref: string;
  name: string | null;
  opened(draftId: string | null): void;
  failed(): void;
};

/** The screens and stores `showRecorder` works with (the router, the mounted recorders, the db). */
export type OpenRecorderDeps = {
  /** Resolves once the pairing sheet has finished closing (or a timeout has passed). */
  sheetGone(): Promise<void>;
  finalizeRecorders(): Promise<void>;
  flushDraftWrites(): Promise<void>;
  findOpenDraft(context: DraftContext): Promise<string | null>;
  /** The recorder on top of the stack, if one is (`recorderOnScreen`). */
  recorderOnScreen(): { place: DraftContext | null; draftId: string | null } | null;
  canDismiss(): boolean;
  dismissAll(): void;
  /** Resolves once no recorder is mounted (or a timeout has passed). */
  recordersGone(): Promise<void>;
  /** Hand the place to the recorder about to open, in memory (`offerRecorderPlace`). */
  offerPlace(place: RecorderPlace): void;
  /** Push a recorder for a link, on `draftId` if given. */
  push(draftId: string | null): void;
};

const samePlace = (a: DraftContext | null, b: DraftContext) =>
  a !== null && a.server === b.server && a.ref === b.ref;

/**
 * Longest a link waits for the take in progress and pending edits to be saved, and the place's
 * draft found. A save never takes this long; one that hasn't settled by then is stuck.
 */
export const SAVE_TIMEOUT_MS = 10_000;

/**
 * How long a pushed recorder has to mount and take its place from memory. The offer lapses then
 * (`offerRecorderPlace`), and the next link's recorder stops waiting for it.
 */
export const HANDOFF_MS = 5000;

/** `work`, or a rejection once `ms` have passed without it settling. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`not done after ${ms} ms`)), ms);
    const settle = () => clearTimeout(timer);
    work.then(resolve, reject).finally(settle);
  });
}

/**
 * Open the recorder for a link's place. First the pairing sheet finishes closing and any recorder
 * saves the take in progress (as its Close does) and edits land; only then is the place's open
 * draft looked for, so a take the running recorder was still recording for it is found rather
 * than doubled by a second draft. A save that never settles (`SAVE_TIMEOUT_MS`) fails this link's
 * recorder, with whatever is on screen left as it is, rather than hold up every link after it.
 *
 * If the recorder on screen is already the one the link asks for — on that draft, or opened for
 * that place with nothing recorded yet — it stays as it is: no second camera start for a link
 * opened twice. Otherwise whatever is up (a recorder, the editor, export) is dismissed, so the
 * link never stacks a second recorder; and the push waits for the old recorder to unmount, so two
 * cameras never run at once. The recorder it pushes is a fresh screen that takes the place from
 * memory (see `link-place.ts`), never from its route; this resolves once it has (or `HANDOFF_MS`
 * has passed), so the next link's place can't replace this one's before it is taken.
 */
export async function showRecorder(target: RecorderTarget, deps: OpenRecorderDeps): Promise<void> {
  await deps.sheetGone();
  const context: DraftContext = { server: target.server, ref: target.ref };
  const draftId = await within(
    (async () => {
      await deps.finalizeRecorders();
      await deps.flushDraftWrites();
      return deps.findOpenDraft(context);
    })(),
    SAVE_TIMEOUT_MS,
  );
  const onScreen = deps.recorderOnScreen();
  const alreadyThere =
    onScreen !== null &&
    (onScreen.draftId !== null
      ? onScreen.draftId === draftId
      : draftId === null && samePlace(onScreen.place, context));
  if (!alreadyThere) {
    if (deps.canDismiss()) {
      deps.dismissAll();
      await deps.recordersGone();
    }
    const taken = new Promise<void>((resolve) =>
      deps.offerPlace({ context, name: target.name, onTaken: resolve }),
    );
    deps.push(draftId);
    // Not done until the recorder has taken its place: the next link's offer would replace it.
    await within(taken, HANDOFF_MS).catch(() => {});
  }
  target.opened(draftId);
}

/**
 * One link's recorder at a time: a second link waits for the first to have opened and taken its
 * place. A recorder
 * that couldn't be opened tells its link (`failed`) and doesn't hold up the next.
 */
export function createRecorderOpener(deps: OpenRecorderDeps): (target: RecorderTarget) => void {
  let opening: Promise<void> = Promise.resolve();
  return (target) => {
    opening = opening
      .then(() => showRecorder(target, deps))
      .catch(() => target.failed())
      // Whatever `failed` does, the next link still gets its turn.
      .catch(() => {});
  };
}
