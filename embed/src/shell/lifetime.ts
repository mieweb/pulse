import type { JobState } from '@/db/upload-jobs';

/**
 * The embedded runtime's lifetime (C6). PulseKit boots Pulse's React Native runtime once (on the
 * first open, a `prewarm()`, or a host write) and keeps it for the process, so the next flow and
 * the job loop start warm. What it costs is given back in two steps:
 *
 * - **Flow end.** The camera and pulse-editor's engines belong to the flow's screens, and they go
 *   when its root unmounts: PulseKit releases the container (and the React root in it) once the
 *   dismissal completes. Nothing here holds them.
 * - **Memory warning.** PulseKit asks (`pulse.cmd memoryWarning`) only while no flow is open and
 *   no forwarded call waits; Pulse JS answers here. With no flow mounted it lets go of the
 *   captions models (they reload on next use). It lets go of the whole runtime (the library
 *   closed, the job loop stopped, then PulseKit drops the instance) only when nothing is running:
 *   no flow, no command, and no job the loop would run. A job's PATCH runs in PulseKit's own
 *   background session (O16), but the loop that asks the host for targets and polls for the
 *   outcome is JavaScript, so a runtime with a live job is never released.
 *
 * Timing marks (C6): `mark(name)` logs the time since the runtime's first module load, so cold and
 * warm starts read off the device log.
 */

/** Job states the loop still has work for: a runtime holding one is never released. */
export const ACTIVE_JOB_STATES: readonly JobState[] = [
  'preparing',
  'queued',
  'uploading',
  'delivering',
];

/** How many of `states` are jobs the loop would run. */
export function countActiveJobs(states: readonly JobState[]): number {
  return states.filter((s) => ACTIVE_JOB_STATES.includes(s)).length;
}

export type RuntimeLoad = {
  /** Flow roots mounted now. */
  flowsOpen: number;
  /** Jobs in ACTIVE_JOB_STATES. */
  activeJobs: number;
  /** Host commands still running (a Send's merge, say). */
  commandsInFlight: number;
};

/** Whether the runtime may be released now: idle, and no job the loop would run. */
export function canReleaseRuntime(load: RuntimeLoad): boolean {
  return load.flowsOpen === 0 && load.activeJobs === 0 && load.commandsInFlight === 0;
}

export type LifetimeDeps = {
  /** Jobs in ACTIVE_JOB_STATES right now (read when the warning comes). */
  activeJobs(): number;
  /** Let go of the captions models (clip queue, whisper, VAD). */
  releaseEngines(): Promise<void>;
  /** Close the library and stop the job loop: after this, the runtime can go. */
  releaseLibrary(): Promise<void>;
  now(): number;
  log(line: string): void;
};

export type Lifetime = {
  /** A flow root mounted; call the returned function when it unmounts. */
  flowOpened(): () => void;
  /** Count `run` as a command in flight while it runs. */
  track<T>(run: () => Promise<T>): Promise<T>;
  /** The load now, as `canReleaseRuntime` reads it. */
  load(): RuntimeLoad;
  /** PulseKit's memory warning: what was let go; `release` means PulseKit may drop the runtime. */
  memoryWarning(): Promise<{ release: boolean }>;
  /** Log a timing mark. */
  mark(name: string): void;
};

export function createLifetime(deps: LifetimeDeps): Lifetime {
  const startedAt = deps.now();
  let flowsOpen = 0;
  let commandsInFlight = 0;
  const marked = new Set<string>();

  const load = (): RuntimeLoad => ({
    flowsOpen,
    activeJobs: deps.activeJobs(),
    commandsInFlight,
  });

  return {
    flowOpened() {
      flowsOpen++;
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        flowsOpen--;
      };
    },
    async track(run) {
      commandsInFlight++;
      try {
        return await run();
      } finally {
        commandsInFlight--;
      }
    },
    load,
    async memoryWarning() {
      const before = load();
      if (before.flowsOpen > 0) {
        deps.log('memory warning: a flow is open; nothing released');
        return { release: false };
      }
      try {
        await deps.releaseEngines();
      } catch (e) {
        deps.log(`memory warning: the captions models weren't released: ${String(e)}`);
      }
      // Read again: a command or a Send may have started while the models went.
      const now = load();
      if (!canReleaseRuntime(now)) {
        deps.log(
          `memory warning: models released; the runtime stays (${now.activeJobs} job(s), ` +
            `${now.commandsInFlight} command(s))`,
        );
        return { release: false };
      }
      await deps.releaseLibrary();
      deps.log('memory warning: idle, so the runtime goes');
      return { release: true };
    },
    mark(name) {
      // Once each per runtime: the first boot, the first command, the library's first open.
      if (marked.has(name)) return;
      marked.add(name);
      deps.log(`mark ${name} +${deps.now() - startedAt} ms`);
    },
  };
}
