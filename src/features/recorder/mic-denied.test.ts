import { describe, expect, it } from '@jest/globals';

import { micMuteStep, micOffer, recorderAllowed } from './mic-denied';

describe('micOffer', () => {
  it('offers to record without sound when the microphone is denied', () => {
    expect(micOffer('authorized', 'denied')).toEqual({ kind: 'without-sound', settings: true });
  });

  it('offers only Settings when the microphone is restricted', () => {
    expect(micOffer('authorized', 'restricted')).toEqual({ kind: 'settings-only', settings: true });
  });

  it('offers nothing when the microphone is allowed', () => {
    expect(micOffer('authorized', 'authorized')).toBeNull();
  });

  it('offers nothing while the microphone has not been asked yet', () => {
    expect(micOffer('authorized', 'not-determined')).toBeNull();
  });

  it('leaves a camera that is not allowed to the blocking camera screen', () => {
    expect(micOffer('denied', 'denied')).toBeNull();
    expect(micOffer('restricted', 'restricted')).toBeNull();
    expect(micOffer('not-determined', 'denied')).toBeNull();
  });
});

describe('recorderAllowed', () => {
  it('needs both permissions in the Pulse app, as before', () => {
    expect(recorderAllowed('authorized', 'authorized', false)).toBe(true);
    expect(recorderAllowed('authorized', 'denied', false)).toBe(false);
    expect(recorderAllowed('authorized', 'restricted', false)).toBe(false);
  });

  it('runs on the camera alone once the microphone was refused, when it is optional', () => {
    expect(recorderAllowed('authorized', 'denied', true)).toBe(true);
    expect(recorderAllowed('authorized', 'restricted', true)).toBe(true);
    // Still asking: the request is in flight, so the recorder waits for the answer.
    expect(recorderAllowed('authorized', 'not-determined', true)).toBe(false);
  });

  it('never runs without the camera', () => {
    for (const mic of ['authorized', 'denied', 'restricted', 'not-determined'] as const) {
      expect(recorderAllowed('denied', mic, true)).toBe(false);
      expect(recorderAllowed('not-determined', mic, true)).toBe(false);
    }
  });
});

describe('micMuteStep', () => {
  const denied = micOffer('authorized', 'denied');
  const restricted = micOffer('authorized', 'restricted');

  it('mutes once when the microphone is refused', () => {
    expect(
      micMuteStep({ offer: denied, micGranted: false, muted: false, mutedForMic: false }),
    ).toBe('mute');
    expect(
      micMuteStep({ offer: restricted, micGranted: false, muted: false, mutedForMic: false }),
    ).toBe('mute');
    expect(micMuteStep({ offer: denied, micGranted: false, muted: true, mutedForMic: true })).toBe(
      'none',
    );
  });

  it('leaves a mute the person chose alone', () => {
    expect(micMuteStep({ offer: denied, micGranted: false, muted: true, mutedForMic: false })).toBe(
      'none',
    );
    expect(micMuteStep({ offer: null, micGranted: true, muted: true, mutedForMic: false })).toBe(
      'none',
    );
  });

  it('unmutes on a later launch once the microphone is allowed', () => {
    // iOS ended the app when the permission changed: the stored mute reads on, and the stored
    // flag says it was the microphone's.
    expect(micMuteStep({ offer: null, micGranted: true, muted: true, mutedForMic: true })).toBe(
      'unmute',
    );
  });

  it('waits while the microphone is not allowed yet', () => {
    // The camera not allowed (no offer either) or the microphone not asked yet.
    expect(micMuteStep({ offer: null, micGranted: false, muted: true, mutedForMic: true })).toBe(
      'none',
    );
  });
});
