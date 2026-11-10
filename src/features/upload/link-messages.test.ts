import { describe, expect, it } from '@jest/globals';

import {
  linkExpiredToast,
  linkRefusedToast,
  openLinkAgain,
  openLinkAgainClause,
  placeOpenedToast,
  recorderFailedToast,
} from './link-messages';

const HOST = 'vault.example.org';

describe('link messages', () => {
  it('says to open a link again in one way, by the place’s label or else the host', () => {
    expect(openLinkAgain({ label: 'Team · Huddle', host: HOST })).toBe(
      'Open the link for Team · Huddle again to upload.',
    );
    expect(openLinkAgain({ label: null, host: HOST })).toBe(
      'Open the link from vault.example.org again to upload.',
    );
    expect(openLinkAgainClause({ host: HOST })).toBe(
      'open the link from vault.example.org again to upload.',
    );
    expect(linkExpiredToast({ label: 'Team · Huddle', host: HOST }).message).toBe(
      openLinkAgain({ label: 'Team · Huddle', host: HOST }),
    );
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
      'vault.example.org didn’t accept it. Open the link from vault.example.org again to upload.',
    );
    expect(recorderFailedToast(HOST).message).toContain(HOST);
  });
});
