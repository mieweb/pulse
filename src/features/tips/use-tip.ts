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

/**
 * One tip's state. `eligible` is whether now is its moment (e.g. the camera is ready and there are
 * no clips yet); the tip shows `delayMs` after that turns true, if it hasn't been shown before and
 * no other tip is showing.
 *
 * Once shown, it's done whichever way it goes: closed, its moment passing (the person did the
 * thing it was about, or moved on), or its screen closing. It never comes back, as Apple's TipKit
 * tips don't, so nobody is taught the same control twice.
 */
export function useTip(id: TipId, eligible: boolean, delayMs = 500) {
  // `undefined` until the shown ids load; a tip only mounts its anchor once it's known unseen.
  const [unseen, setUnseen] = useState<boolean | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const shownRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadSeen().then((ids) => {
      if (!cancelled) setUnseen(!ids.has(id) && !ids.has(ALL));
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const dismiss = useCallback(() => {
    if (!shownRef.current) return;
    shownRef.current = false;
    if (active === id) active = null;
    setShown(false);
    setUnseen(false);
    void loadSeen().then((ids) => ids.add(id));
    markTipSeen(id).catch((e: unknown) => console.warn('[tips] failed to save a shown tip', e));
  }, [id]);

  // Show after the delay once it's the tip's moment; done for good if the moment passes.
  useEffect(() => {
    if (!unseen) return;
    if (!eligible) {
      dismiss();
      return;
    }
    if (shownRef.current) return;
    const timer = setTimeout(() => {
      if (active != null) return;
      active = id;
      shownRef.current = true;
      setShown(true);
    }, delayMs);
    return () => clearTimeout(timer);
  }, [unseen, eligible, delayMs, id, dismiss]);

  // Its screen closing counts as seen too.
  useEffect(() => dismiss, [dismiss]);

  return { mounted: unseen === true, shown, dismiss };
}
