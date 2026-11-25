import { expect, it, jest } from '@jest/globals';

import { VoiceoverSession, type CapturedVoiceover } from './voiceover-session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const take: CapturedVoiceover = {
  uri: 'file:///take.caf',
  startMs: 12000,
  endMs: 14500,
  sourceStartMs: 15,
  durationMs: 2520,
  pressToPlaybackMs: 4,
  pressToCaptureMs: 2,
  stopAlignmentMs: 0.02,
  audioVideoOffsetMs: 0.01,
};

function setup() {
  const ports = {
    prepare: jest.fn(async () => {}),
    start: jest.fn(async () => 12000),
    stop: jest.fn(async () => take),
    cancel: jest.fn(),
    discard: jest.fn(),
    save: jest.fn(async (_take: CapturedVoiceover) => {}),
    changed: jest.fn(),
  };
  return { ports, session: new VoiceoverSession(ports) };
}

it('commits four independent holds; a duplicate release cannot save a take twice', async () => {
  const { ports, session } = setup();
  await session.prepare();
  for (let i = 0; i < 4; i++) {
    session.press();
    await Promise.resolve();
    expect(session.phase).toBe('recording');
    await Promise.all([session.release(), session.release()]);
    expect(session.phase).toBe('ready');
  }
  expect(ports.start).toHaveBeenCalledTimes(4);
  expect(ports.stop).toHaveBeenCalledTimes(4);
  expect(ports.save).toHaveBeenCalledTimes(4);
  expect(ports.save).toHaveBeenLastCalledWith(take);
});

it('stops and saves even when the finger lifts before native start answers', async () => {
  const { ports, session } = setup();
  const started = deferred<number>();
  ports.start.mockReturnValueOnce(started.promise);
  await session.prepare();
  session.press();
  const finished = session.release();
  session.press(); // no second microphone capture while stopping
  started.resolve(12000);
  await finished;
  expect(ports.start).toHaveBeenCalledTimes(1);
  expect(ports.stop).toHaveBeenCalledTimes(1);
  expect(ports.save).toHaveBeenCalledTimes(1);
});

it('cancellation during a pending stop preserves all previously saved narration', async () => {
  const { ports, session } = setup();
  const stopped = deferred<CapturedVoiceover>();
  ports.stop.mockReturnValueOnce(stopped.promise);
  await session.prepare();
  session.press();
  const finished = session.release();
  await Promise.resolve();
  session.cancel();
  stopped.resolve(take);
  await finished;
  expect(ports.cancel).toHaveBeenCalledTimes(1);
  expect(ports.save).not.toHaveBeenCalled();
});

it('retries a failed save with the original captured file and clock positions', async () => {
  const { ports, session } = setup();
  ports.save.mockRejectedValueOnce(new Error('disk full'));
  await session.prepare();
  session.press();
  await session.release();
  expect(session.phase).toBe('failed');
  expect(session.canRetrySave).toBe(true);
  await session.retry();
  expect(session.phase).toBe('ready');
  expect(ports.save.mock.calls).toEqual([[take], [take]]);
  expect(ports.start).toHaveBeenCalledTimes(1);
});

it('a refused microphone never starts playback or commits a take', async () => {
  const { ports, session } = setup();
  ports.prepare.mockRejectedValueOnce(new Error('permission denied'));
  await session.prepare();
  session.press();
  await session.release();
  expect(ports.start).not.toHaveBeenCalled();
  expect(ports.save).not.toHaveBeenCalled();
  expect(session.phase).toBe('failed');
});

it('keeps the next hold out until a durable save and its preview rebuild finish', async () => {
  const { ports, session } = setup();
  const saved = deferred<void>();
  ports.save.mockReturnValueOnce(saved.promise);
  await session.prepare();
  session.press();
  const finish = session.release();
  await Promise.resolve();
  await Promise.resolve();
  session.press();
  expect(session.phase).toBe('saving');
  expect(ports.start).toHaveBeenCalledTimes(1);
  saved.resolve();
  await finish;
  session.press();
  expect(ports.start).toHaveBeenCalledTimes(2);
  await session.release();
});

it('rearms the microphone when retrying an unsaved take after an interruption', async () => {
  const { ports, session } = setup();
  ports.save.mockRejectedValueOnce(new Error('disk full'));
  await session.prepare();
  session.press();
  await session.release();
  session.interrupt(new Error('background'));
  await session.retry();
  expect(ports.prepare).toHaveBeenCalledTimes(2);
  expect(ports.save).toHaveBeenCalledTimes(2);
  expect(session.phase).toBe('ready');
});

it('waits for an interrupted save to finish before retrying and does not save it twice', async () => {
  const { ports, session } = setup();
  const saving = deferred<void>();
  const saved = deferred<void>();
  ports.save.mockImplementationOnce(async () => {
    saving.resolve();
    await saved.promise;
  });
  await session.prepare();
  session.press();
  const finish = session.release();
  await saving.promise;
  session.interrupt(new Error('background'));
  const retry = session.retry();
  const writesBeforeCompletion = ports.save.mock.calls.length;
  saved.resolve();
  await Promise.all([finish, retry]);
  expect(writesBeforeCompletion).toBe(1);
  expect(ports.save).toHaveBeenCalledTimes(1);
  expect(ports.prepare).toHaveBeenCalledTimes(2);
  expect(session.canRetrySave).toBe(false);
  expect(session.phase).toBe('ready');
});

it('retries the original file only after an interrupted save actually fails', async () => {
  const { ports, session } = setup();
  const saving = deferred<void>();
  const saved = deferred<void>();
  const retrySaving = deferred<void>();
  const retrySaved = deferred<void>();
  ports.save.mockImplementationOnce(async () => {
    saving.resolve();
    await saved.promise;
  });
  ports.save.mockImplementationOnce(async () => {
    retrySaving.resolve();
    await retrySaved.promise;
  });
  await session.prepare();
  session.press();
  const finish = session.release();
  await saving.promise;
  session.interrupt(new Error('background'));
  const retry = session.retry();
  const writesBeforeFailure = ports.save.mock.calls.length;
  saved.reject(new Error('disk full'));
  await retrySaving.promise;
  retrySaved.resolve();
  await Promise.all([finish, retry]);
  expect(writesBeforeFailure).toBe(1);
  expect(ports.save.mock.calls).toEqual([[take], [take]]);
  expect(session.phase).toBe('ready');
});

it.each(['success', 'failure'] as const)(
  'serializes another interruption and Retry behind an active retry save ending in %s',
  async (outcome) => {
    const { ports, session } = setup();
    ports.save.mockRejectedValueOnce(new Error('disk full'));
    await session.prepare();
    session.press();
    await session.release();
    session.interrupt(new Error('background'));
    const saving = deferred<void>();
    const saved = deferred<void>();
    ports.save.mockImplementationOnce(async () => {
      saving.resolve();
      await saved.promise;
    });
    const firstRetry = session.retry();
    await saving.promise;
    session.interrupt(new Error('background again'));
    const nextRetry = session.retry();
    const writesBeforeCompletion = ports.save.mock.calls.length;
    if (outcome === 'success') saved.resolve();
    else saved.reject(new Error('still full'));
    await Promise.all([firstRetry, nextRetry]);
    expect(writesBeforeCompletion).toBe(2);
    expect(ports.save.mock.calls).toEqual(
      outcome === 'success' ? [[take], [take]] : [[take], [take], [take]],
    );
    expect(ports.prepare).toHaveBeenCalledTimes(2);
    expect(session.canRetrySave).toBe(false);
    expect(session.phase).toBe('ready');
  },
);

it.each(['interrupt', 'dispose'] as const)(
  'invalidates a queued retry after another %s before the original save settles',
  async (action) => {
    const { ports, session } = setup();
    const saving = deferred<void>();
    const saved = deferred<void>();
    ports.save.mockImplementationOnce(async () => {
      saving.resolve();
      await saved.promise;
    });
    await session.prepare();
    session.press();
    const finish = session.release();
    await saving.promise;
    session.interrupt(new Error('background'));
    const retry = session.retry();
    if (action === 'interrupt') session.interrupt(new Error('background again'));
    else session.dispose();
    saved.resolve();
    await Promise.all([finish, retry]);
    expect(ports.save).toHaveBeenCalledTimes(1);
    expect(ports.prepare).toHaveBeenCalledTimes(1);
    if (action === 'interrupt') expect(session.phase).toBe('failed');
  },
);

it('retains a retrying file until its save settles when the workflow is disposed', async () => {
  const { ports, session } = setup();
  ports.save.mockRejectedValueOnce(new Error('disk full'));
  await session.prepare();
  session.press();
  await session.release();
  const saving = deferred<void>();
  const saved = deferred<void>();
  ports.save.mockImplementationOnce(async () => {
    saving.resolve();
    await saved.promise;
  });
  const retry = session.retry();
  await saving.promise;
  session.dispose();
  const discardsBeforeCompletion = ports.discard.mock.calls.length;
  saved.reject(new Error('still full'));
  await retry;
  await Promise.resolve();
  expect(discardsBeforeCompletion).toBe(0);
  expect(ports.discard.mock.calls).toEqual([[take]]);
  expect(session.canRetrySave).toBe(false);
});

it('does not replace a newer interruption with a stale retry rearm failure', async () => {
  const { ports, session } = setup();
  ports.save.mockRejectedValueOnce(new Error('disk full'));
  await session.prepare();
  session.press();
  await session.release();
  session.interrupt(new Error('background'));
  const preparing = deferred<void>();
  const prepared = deferred<void>();
  ports.prepare.mockImplementationOnce(async () => {
    preparing.resolve();
    await prepared.promise;
  });
  const retry = session.retry();
  await preparing.promise;
  const interruption = new Error('background again');
  session.interrupt(interruption);
  prepared.reject(new Error('stale microphone error'));
  await retry;
  expect(session.phase).toBe('failed');
  expect(ports.changed).toHaveBeenLastCalledWith('failed', interruption);
});
