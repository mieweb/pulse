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
