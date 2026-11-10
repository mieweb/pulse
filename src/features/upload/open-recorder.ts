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
 * Open the recorder for a link's place. First the pairing sheet finishes closing and any recorder
 * saves the take in progress (as its Close does) and edits land; only then is the place's open
 * draft looked for, so a take the running recorder was still recording for it is found rather
 * than doubled by a second draft.
 *
 * If the recorder on screen is already the one the link asks for — on that draft, or opened for
 * that place with nothing recorded yet — it stays as it is: no second camera start for a link
 * opened twice. Otherwise whatever is up (a recorder, the editor, export) is dismissed, so the
 * link never stacks a second recorder; and the push waits for the old recorder to unmount, so two
 * cameras never run at once. The recorder it pushes is a fresh screen that takes the place from
 * memory (see `link-place.ts`), never from its route.
 */
export async function showRecorder(target: RecorderTarget, deps: OpenRecorderDeps): Promise<void> {
  await deps.sheetGone();
  await deps.finalizeRecorders();
  await deps.flushDraftWrites();
  const context: DraftContext = { server: target.server, ref: target.ref };
  const draftId = await deps.findOpenDraft(context);
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
    deps.offerPlace({ context, name: target.name });
    deps.push(draftId);
  }
  target.opened(draftId);
}

/**
 * One link's recorder at a time: a second link waits for the first to have opened. A recorder
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
