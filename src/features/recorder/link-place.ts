import type { DraftContext } from '@/db/drafts';

/**
 * What a link for a place gives the recorder it opens: the place a draft made there is recorded
 * for, and the name the link gives a new one.
 */
export type RecorderPlace = {
  context: DraftContext;
  name: string | null;
  /** Called once, when a recorder takes the place (what the link's toast waits for). */
  onTaken?: () => void;
};

/**
 * The place waiting for a recorder, handed over in memory. Not through the recorder's route
 * params: the router encodes and decodes those more than once, so a place's key with a `%` in it
 * (`ticket%3A12`) would arrive as another key (`ticket:12`) and the draft would never match its
 * destination. A `ref` is the host's opaque string and has to arrive exactly as it was read.
 */
let offer: { place: RecorderPlace; until: number } | null = null;

/**
 * Offer `place` to the next recorder that opens for a new draft or for a link (see
 * `peekRecorderPlace`), until `untilMs`. A newer offer replaces an older one.
 */
export function offerRecorderPlace(place: RecorderPlace, untilMs: number): void {
  offer = { place, until: untilMs };
}

/**
 * The place on offer, if it still stands. Reading it changes nothing (a recorder reads it while
 * rendering, which React may do more than once); the recorder that mounts with it then calls
 * `takeRecorderPlace`.
 */
export function peekRecorderPlace(nowMs: number = Date.now()): RecorderPlace | null {
  if (offer && nowMs >= offer.until) offer = null;
  return offer?.place ?? null;
}

/** The recorder has mounted with `place`: the offer is spent. Safe to call twice. */
export function takeRecorderPlace(place: RecorderPlace): void {
  if (offer?.place !== place) return;
  offer = null;
  place.onTaken?.();
}

/** Drop any offer (the tests' reset). */
export function withdrawRecorderPlace(): void {
  offer = null;
}
