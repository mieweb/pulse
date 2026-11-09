import { describe, expect, it } from '@jest/globals';

import { createPresence } from './presence';

describe('createPresence', () => {
  it('resolves at once when nothing is mounted', async () => {
    await expect(createPresence().whenGone(10_000)).resolves.toBeUndefined();
  });

  it('waits for the last one to leave, and a leave counts once', async () => {
    const presence = createPresence();
    const leaveA = presence.enter();
    const leaveB = presence.enter();
    let gone = false;
    const waiting = presence.whenGone(10_000).then(() => {
      gone = true;
    });
    leaveA();
    leaveA();
    await Promise.resolve();
    expect(gone).toBe(false);
    leaveB();
    await waiting;
    expect(gone).toBe(true);
  });

  it('gives up waiting after the timeout', async () => {
    const presence = createPresence();
    presence.enter();
    await expect(presence.whenGone(5)).resolves.toBeUndefined();
  });
});
