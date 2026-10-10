import { useCallback, useEffect, useRef, useState } from 'react';

import { markTipSeen, seenTips } from '@/db/settings';

import type { TipId } from './tips';

/** Stands for every tip when the shown ones can't be read. */
const ALL = '*';

/** The tips already shown, read once per launch. */
let seen: Promise<Set<string>> | null = null;
function loadSeen(): Promise<Set<string>> {
  seen ??= seenTips().catch((e: unknown) => {
    // Unreadable: show no tips this launch rather than repeat ones already seen.
    console.warn('[tips] failed to read shown tips', e);
    seen = null;
    return new Set([ALL]);
  });
  return seen;
}

/** The tip on screen now: one at a time, so two never stack up or race for the same moment. */
let active: TipId | null = null;

/** How long a closed tip's anchor stays mounted, so the popover can animate back into its control. */
const EXIT_MS = 400;

/**
 * One tip's state. `eligible` is whether now is its moment (e.g. the camera is ready and there are
 * no clips yet); the tip shows `delayMs` after that turns true, if it hasn't been shown before and
 * no other tip is showing.
 *
 * Once shown, it's done whichever way it goes: closed, its moment passing, or its screen closing.
 * Before it shows, a moment passing only puts it off; `learned` turning true (the person did the
 * thing it teaches) or `retire()` ends it for good, shown or not, as TipKit's invalidation does —
 * so nobody is taught a control they've already found, or the same control twice.
 */
export function useTip(
  id: TipId,
  eligible: boolean,
  { delayMs = 500, learned = false }: { delayMs?: number; learned?: boolean } = {},
) {
  // `undefined` until the shown ids load; a tip only mounts its anchor once it's known unseen.
  const [unseen, setUnseen] = useState<boolean | undefined>(undefined);
  const unseenRef = useRef<boolean | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const shownRef = useRef(false);
  // Set when it's done: the anchor outlives a shown tip for its exit, but it mustn't show again.
  const doneRef = useRef(false);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void loadSeen().then((ids) => {
      if (cancelled) return;
      // Retired while this read was in flight (`learned` came first): stays done.
      unseenRef.current = !doneRef.current && !ids.has(id) && !ids.has(ALL);
      setUnseen(unseenRef.current);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  /** Done for good, shown or not: hidden if it's up, and remembered. */
  const retire = useCallback(() => {
    if (doneRef.current || unseenRef.current === false) return;
    doneRef.current = true;
    const wasShown = shownRef.current;
    shownRef.current = false;
    if (active === id) active = null;
    setShown(false);
    // Unmounting the anchor with the popover still up would cut its exit short.
    unmountTimer.current = setTimeout(() => setUnseen(false), wasShown ? EXIT_MS : 0);
    void loadSeen().then((ids) => ids.add(id));
    markTipSeen(id).catch((e: unknown) => console.warn('[tips] failed to save a shown tip', e));
  }, [id]);

  /** Closes the tip if it's showing (and so retires it); does nothing before it shows. */
  const dismiss = useCallback(() => {
    if (shownRef.current) retire();
  }, [retire]);

  useEffect(() => {
    if (learned) retire();
  }, [learned, retire]);

  // Show after the delay once it's the tip's moment; done for good if the moment passes while
  // it's up, put off if it passes before.
  useEffect(() => {
    if (!unseen || doneRef.current) return;
    if (!eligible) {
      dismiss();
      return;
    }
    if (shownRef.current) return;
    const timer = setTimeout(() => {
      if (active != null || doneRef.current) return;
      active = id;
      shownRef.current = true;
      setShown(true);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [unseen, eligible, delayMs, id, dismiss]);

  // Its screen closing counts as seen too.
  useEffect(
    () => () => {
      dismiss();
      clearTimeout(unmountTimer.current);
    },
    [dismiss],
  );

  return { mounted: unseen === true, shown, dismiss, retire };
}
