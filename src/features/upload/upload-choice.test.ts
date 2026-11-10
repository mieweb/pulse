import { describe, expect, it } from '@jest/globals';

import type { DestinationOption } from './destination-options';
import { type DraftPlace, returnToFor, uploadChoice } from './upload-choice';

const SERVER = 'https://vault.example.org/pulsevault';
const REF = 'ticket%3A12:a/b';

const option = (id: string, over: Partial<DestinationOption> = {}): DestinationOption => ({
  id,
  server: SERVER,
  artifactId: `art-${id}`,
  ref: null,
  label: null,
  app: null,
  returnUrl: null,
  token: null,
  expiresAtMs: null,
  expiryLabel: 'No expiry',
  ...over,
});
const draftFor = (over: Partial<DraftPlace> = {}): DraftPlace => ({
  server: SERVER,
  ref: REF,
  name: null,
  uploadStatus: null,
  ...over,
});
const PLAIN_DRAFT: DraftPlace = { server: null, ref: null, name: null, uploadStatus: null };
const choose = (args: Partial<Parameters<typeof uploadChoice>[0]>) =>
  uploadChoice({
    draft: PLAIN_DRAFT,
    pool: [],
    poolReady: true,
    placeLabel: null,
    pickedId: null,
    ...args,
  });

describe('uploadChoice: a draft recorded for no place', () => {
  it('defaults to the newest destination, in the pool’s own order', () => {
    const pool = [option('newest'), option('older', { ref: 'some-place' })];
    const choice = choose({ pool });
    expect(choice.selectedId).toBe('newest');
    expect(choice.destinations.map((d) => d.id)).toEqual(['newest', 'older']);
    expect(choice.ownDestination).toBeNull();
    expect(choice.reopen).toBeNull();
  });

  it('never asks for a new link, with an empty pool or a full one', () => {
    expect(choose({}).reopen).toBeNull();
    expect(choose({ pool: [option('a')] }).reopen).toBeNull();
  });
});

describe('uploadChoice: a draft recorded for a place', () => {
  const own = option('own', { ref: REF, label: 'Team · Huddle' });

  it('preselects its place’s destination and lists it first', () => {
    const choice = choose({ draft: draftFor(), pool: [option('newest'), own, option('other')] });
    expect(choice.selectedId).toBe('own');
    expect(choice.ownDestination).toBe(own);
    expect(choice.destinations.map((d) => d.id)).toEqual(['own', 'newest', 'other']);
    expect(choice.reopen).toBeNull();
  });

  it('matches its place on server and key, exactly', () => {
    for (const other of [
      option('same-key-other-server', { server: 'https://other.example.org', ref: REF }),
      option('decoded-key', { ref: 'ticket:12:a/b' }),
      option('plain'),
    ]) {
      expect(choose({ draft: draftFor(), pool: [other] }).ownDestination).toBeNull();
    }
  });

  it('never falls back to another destination: nothing is selected, and it says what to do', () => {
    const choice = choose({ draft: draftFor(), pool: [option('newest'), option('other')] });
    expect(choice.selectedId).toBeNull();
    expect(choice.reopen).toBe('Open a new link from vault.example.org to upload.');
    // The person can still pick one.
    expect(choose({ draft: draftFor(), pool: [option('a')], pickedId: 'a' }).selectedId).toBe('a');
  });

  it('names the link to open again by the draft’s own name, else the place’s label, else the host', () => {
    const say = (draft: DraftPlace, placeLabel: string | null = null) =>
      choose({ draft, placeLabel }).reopen;
    expect(say(draftFor({ name: 'Huddle update' }), 'Team · Huddle')).toBe(
      'Open a new link for Huddle update to upload.',
    );
    // Unnamed, while the place's expired row is still in the pool.
    expect(say(draftFor(), 'Team · Huddle')).toBe('Open a new link for Team · Huddle to upload.');
    // After a claim the row is gone: the host.
    expect(say(draftFor())).toBe('Open a new link from vault.example.org to upload.');
  });

  it('says it after a failed or cancelled upload, which leaves the draft unsent with its place', () => {
    // The row was spent at the claim; the draft is unpaired again.
    const choice = choose({ draft: draftFor({ name: 'Huddle update', uploadStatus: null }) });
    expect(choice.reopen).toBe('Open a new link for Huddle update to upload.');
    // A new link for the place: its fresh row is the draft's own again.
    const fresh = option('fresh', { ref: REF });
    const again = choose({ draft: draftFor({ name: 'Huddle update' }), pool: [fresh] });
    expect(again.selectedId).toBe('fresh');
    expect(again.reopen).toBeNull();
  });

  it('says nothing while it uploads (its link was just claimed) or once it is uploaded', () => {
    expect(choose({ draft: draftFor({ uploadStatus: 'uploading' }) }).reopen).toBeNull();
    expect(choose({ draft: draftFor({ uploadStatus: 'uploaded' }) }).reopen).toBeNull();
  });

  it('says nothing before the pool has loaded: an empty pool then is not a missing link', () => {
    expect(choose({ draft: draftFor(), poolReady: false }).reopen).toBeNull();
    expect(choose({ draft: draftFor(), poolReady: true }).reopen).not.toBeNull();
  });

  it('keeps the person’s pick while it is in the pool, and goes back to its own when it isn’t', () => {
    const pool = [own, option('other')];
    expect(choose({ draft: draftFor(), pool, pickedId: 'other' }).selectedId).toBe('other');
    expect(choose({ draft: draftFor(), pool, pickedId: 'gone' }).selectedId).toBe('own');
  });
});

describe('uploadChoice: before the draft has loaded', () => {
  it('selects nothing by default, so a place’s draft is never offered the wrong destination first', () => {
    const choice = choose({ draft: undefined, pool: [option('newest')] });
    expect(choice.selectedId).toBeNull();
    expect(choice.reopen).toBeNull();
  });
});

describe('returnToFor', () => {
  const RETURN = 'https://timehuddle.example.org/app/huddle';
  const own = option('own', { ref: REF, returnUrl: RETURN, app: 'TimeHuddle' });

  it('is the way back of the draft’s own place', () => {
    expect(returnToFor(draftFor(), own)).toEqual({ url: RETURN, app: 'TimeHuddle' });
    expect(returnToFor(draftFor(), { ...own, app: null })).toEqual({ url: RETURN, app: null });
  });

  it('is none when the draft was uploaded somewhere that isn’t its own place', () => {
    expect(returnToFor(draftFor(), { ...own, ref: 'another-place' })).toBeNull();
    expect(returnToFor(draftFor(), { ...own, server: 'https://other.example.org' })).toBeNull();
    // A draft recorded for no place, sent to a place's destination.
    expect(returnToFor(PLAIN_DRAFT, own)).toBeNull();
    expect(returnToFor(undefined, own)).toBeNull();
  });

  it('is none when the place’s link carried no return URL', () => {
    expect(returnToFor(draftFor(), { ...own, returnUrl: null })).toBeNull();
  });
});
