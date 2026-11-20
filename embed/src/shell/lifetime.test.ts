import { describe, expect, it, jest } from '@jest/globals';

import { canReleaseRuntime, countActiveJobs, createLifetime, type LifetimeDeps } from './lifetime';

// lifetime.ts imports only the JobState type from upload-jobs, but keep the client out regardless.
jest.mock('@/db/client', () => ({ db: {} }));

function fakeRuntime(jobs = 0) {
  const done: string[] = [];
  const deps: LifetimeDeps = {
    activeJobs: () => jobs,
    releaseEngines: async () => void done.push('engines'),
    releaseLibrary: async () => void done.push('library'),
    now: () => 1000,
    log: () => {},
  };
  return { done, lifetime: createLifetime(deps) };
}

describe('canReleaseRuntime', () => {
  it('only when idle: no flow, no command, no active job', () => {
    const idle = { flowsOpen: 0, activeJobs: 0, commandsInFlight: 0 };
    expect(canReleaseRuntime(idle)).toBe(true);
    expect(canReleaseRuntime({ ...idle, activeJobs: 1 })).toBe(false);
    expect(canReleaseRuntime({ ...idle, flowsOpen: 1 })).toBe(false);
    expect(canReleaseRuntime({ ...idle, commandsInFlight: 1 })).toBe(false);
  });

  it('counts the jobs the loop still has work for; paused and failed ones are not active', () => {
    expect(
      countActiveJobs([
        'preparing',
        'queued',
        'uploading',
        'delivering',
        'needs_credentials',
        'failed',
      ]),
    ).toBe(4);
    expect(countActiveJobs(['needs_credentials', 'failed'])).toBe(0);
  });
});

describe('memory warning', () => {
  it('never releases the runtime with an active job', async () => {
    const r = fakeRuntime(1);
    expect(await r.lifetime.memoryWarning()).toEqual({ release: false });
    expect(r.done).toEqual(['engines']); // the captions models still go
  });

  it('a job that starts while the models are released keeps the runtime', async () => {
    const done: string[] = [];
    let jobs = 0;
    const lifetime = createLifetime({
      activeJobs: () => jobs,
      releaseEngines: async () => {
        jobs = 1; // a Send queued meanwhile
      },
      releaseLibrary: async () => void done.push('library'),
      now: () => 0,
      log: () => {},
    });
    expect(await lifetime.memoryWarning()).toEqual({ release: false });
    expect(done).toEqual([]);
  });

  it('releases an idle runtime: the models, then the library', async () => {
    const r = fakeRuntime(0);
    expect(await r.lifetime.memoryWarning()).toEqual({ release: true });
    expect(r.done).toEqual(['engines', 'library']);
  });

  it('releases nothing while a flow is open, and again once it closed', async () => {
    const r = fakeRuntime(0);
    const close = r.lifetime.flowOpened();
    expect(await r.lifetime.memoryWarning()).toEqual({ release: false });
    expect(r.done).toEqual([]);
    close();
    close(); // a second unmount doesn't count twice
    expect(r.lifetime.load().flowsOpen).toBe(0);
    expect(await r.lifetime.memoryWarning()).toEqual({ release: true });
  });

  it('keeps the runtime while a command runs, and counts it out when it fails', async () => {
    const r = fakeRuntime(0);
    let finish: () => void = () => {};
    const running = r.lifetime.track(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    expect(await r.lifetime.memoryWarning()).toEqual({ release: false });
    finish();
    await running;
    await expect(
      r.lifetime.track(async () => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    expect(r.lifetime.load().commandsInFlight).toBe(0);
    expect(await r.lifetime.memoryWarning()).toEqual({ release: true });
  });
});

describe('timing marks', () => {
  it('logs each mark once, as time since the runtime started', () => {
    const lines: string[] = [];
    let now = 100;
    const lifetime = createLifetime({
      activeJobs: () => 0,
      releaseEngines: async () => {},
      releaseLibrary: async () => {},
      now: () => now,
      log: (line) => void lines.push(line),
    });
    now = 350;
    lifetime.mark('library');
    now = 900;
    lifetime.mark('library');
    lifetime.mark('command');
    expect(lines).toEqual(['mark library +250 ms', 'mark command +800 ms']);
  });
});
