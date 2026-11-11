import { describe, expect, it } from '@jest/globals';

import {
  backToHost,
  linkExpiredToast,
  linkRefusedToast,
  openNewLink,
  placeCheckingToast,
  placeOpenedToast,
  recorderFailedToast,
} from './link-messages';

const HOST = 'vault.example.org';

describe('link messages', () => {
  it('asks for a new link in one way, by the place’s label or else the host', () => {
    expect(openNewLink({ label: 'Team · Huddle', host: HOST })).toBe(
      'Open a new link for Team · Huddle to upload.',
    );
    expect(openNewLink({ label: null, host: HOST })).toBe(
      'Open a new link from vault.example.org to upload.',
    );
    expect(linkExpiredToast({ label: 'Team · Huddle', host: HOST }).message).toBe(
      openNewLink({ label: 'Team · Huddle', host: HOST }),
    );
  });

  it('says which server is being asked while a place’s recorder waits for it', () => {
    expect(placeCheckingToast({ label: 'Team · Huddle', host: HOST })).toEqual({
      title: 'Team · Huddle',
      message: 'Checking with vault.example.org…',
    });
    expect(placeCheckingToast({ label: null, host: HOST })).toEqual({
      title: 'Opening the link',
      message: 'Checking with vault.example.org…',
    });
  });

  it('always names the server a place’s video goes to, whatever the link calls the place', () => {
    for (const draftOpen of [true, false]) {
      const labelled = placeOpenedToast({ label: 'Team · Huddle', host: HOST, draftOpen });
      expect(labelled.title).toBe('Team · Huddle');
      expect(labelled.message).toContain(HOST);
      const bare = placeOpenedToast({ label: null, host: HOST, draftOpen });
      expect(bare.title).toBe('Connected to vault.example.org');
      expect(bare.message).toContain(HOST);
    }
    expect(placeOpenedToast({ label: 'L', host: HOST, draftOpen: true }).message).toBe(
      'Your draft is open. It uploads to vault.example.org.',
    );
    expect(
      placeOpenedToast({ label: 'L', host: HOST, draftOpen: false, trustNotSaved: true }).message,
    ).toBe('Record, then upload to vault.example.org. Pulse couldn’t save “Don’t ask again”.');
  });

  it('names the host that refused a link, and where a video still goes when the recorder didn’t open', () => {
    expect(linkRefusedToast({ label: null, host: HOST }).message).toBe(
      'vault.example.org didn’t accept it. Open a new link from vault.example.org to upload.',
    );
    expect(recorderFailedToast(HOST).message).toContain(HOST);
  });
});

describe('backToHost', () => {
  const cp = String.fromCodePoint;

  it('says the app’s name and always the host the button opens', () => {
    expect(
      backToHost({ url: 'https://timehuddle.example.org/app?team=t1', app: 'TimeHuddle' }),
    ).toEqual({
      url: 'https://timehuddle.example.org/app?team=t1',
      label: 'Back to TimeHuddle · timehuddle.example.org',
      unusualHost: false,
    });
    expect(backToHost({ url: 'https://timehuddle.example.org/', app: null })?.label).toBe(
      'Back to timehuddle.example.org',
    );
    // An app name that is only the host again isn't said twice.
    expect(
      backToHost({ url: 'https://timehuddle.example.org/', app: 'TimeHuddle.example.org' })?.label,
    ).toBe('Back to timehuddle.example.org');
  });

  it('ends on the host whatever the app is called, and never loses the end of a long host', () => {
    const spoof = backToHost({
      url: 'https://evil.example/',
      app: 'TimeHuddle · timehuddle.com',
    })!;
    expect(spoof.label.endsWith(' · evil.example')).toBe(true);

    const longHost = `timehuddle.com.${'a'.repeat(60)}.evil.example`;
    const long = backToHost({ url: `https://${longHost}/`, app: 'TimeHuddle' })!;
    // Shortened by dropping subdomains: none of the misleading prefix, all of the domain.
    expect(long.label).toBe('Back to TimeHuddle · ….evil.example');
    expect(long.label.length).toBeLessThan(`Back to TimeHuddle · ${longHost}`.length);
  });

  it('cleans the app’s name: no text-direction character can reorder the host after it', () => {
    const back = backToHost({ url: 'https://evil.example/', app: `TimeHuddle${cp(0x202e)}` })!;
    expect(back.label).toBe('Back to TimeHuddle · evil.example');
  });

  it('flags a host that could pass for another name', () => {
    expect(
      backToHost({ url: `https://timehuddl${cp(0x435)}.example/`, app: null })?.unusualHost,
    ).toBe(true);
    expect(backToHost({ url: 'https://xn--timehuddl-8ya.example/', app: null })?.unusualHost).toBe(
      true,
    );
  });

  it('offers nothing for no return URL, or one Pulse must ignore', () => {
    expect(backToHost(null)).toBeNull();
    expect(
      backToHost({ url: 'https://timehuddle.example.org@evil.example/', app: 'TimeHuddle' }),
    ).toBeNull();
    expect(backToHost({ url: 'http://evil.example/', app: null })).toBeNull();
    expect(backToHost({ url: `https://host.example/${'p'.repeat(600)}`, app: null })).toBeNull();
  });
});
