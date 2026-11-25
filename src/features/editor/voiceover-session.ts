import type { VoiceoverTake } from '@mieweb/pulse-editor';

/** One native microphone take, anchored to the player's clock rather than JS event times. */
export type CapturedVoiceover = VoiceoverTake;

export type VoiceoverPhase = 'preparing' | 'ready' | 'starting' | 'recording' | 'saving' | 'failed';

type Ports = {
  prepare: () => Promise<void>;
  start: () => Promise<number>;
  stop: () => Promise<CapturedVoiceover>;
  cancel: () => void;
  save: (take: CapturedVoiceover) => Promise<void>;
  discard?: (take: CapturedVoiceover) => void;
  changed: (phase: VoiceoverPhase, error?: unknown) => void;
};

/**
 * Serializes a hold/release, including a release before native start answers. Saving owns the
 * workflow until the take is durable; a failed save can be retried without recording again.
 * An interruption invalidates a pending start/stop, so it cannot commit a canceled take.
 */
export class VoiceoverSession {
  phase: VoiceoverPhase = 'preparing';
  private generation = 0;
  private held = false;
  private startTask: Promise<void> | null = null;
  private finishTask: Promise<void> | null = null;
  private unsaved: CapturedVoiceover | null = null;
  private prepared = false;

  constructor(private readonly ports: Ports) {}

  private change(phase: VoiceoverPhase, error?: unknown) {
    this.phase = phase;
    this.ports.changed(phase, error);
  }

  async prepare() {
    const generation = ++this.generation;
    this.change('preparing');
    try {
      await this.ports.prepare();
      if (generation === this.generation) {
        this.prepared = true;
        this.change('ready');
      }
    } catch (error) {
      if (generation === this.generation) this.change('failed', error);
    }
  }

  press() {
    if (this.phase !== 'ready') return;
    this.held = true;
    const generation = this.generation;
    this.change('starting');
    this.startTask = this.ports.start().then(
      () => {
        if (generation === this.generation && this.held) this.change('recording');
      },
      (error) => {
        if (generation === this.generation) {
          this.held = false;
          this.change('failed', error);
        }
      },
    );
  }

  release(): Promise<void> {
    this.held = false;
    if (this.finishTask) return this.finishTask;
    if (this.phase !== 'starting' && this.phase !== 'recording') return Promise.resolve();
    const generation = this.generation;
    this.change('saving');
    const task = (async () => {
      await this.startTask;
      if (generation !== this.generation || this.phase === 'failed') return;
      try {
        const take = await this.ports.stop();
        if (generation !== this.generation) {
          this.ports.discard?.(take);
          return;
        }
        this.unsaved = take;
        await this.save(generation);
      } catch (error) {
        if (generation === this.generation) this.change('failed', error);
      }
    })();
    this.finishTask = task;
    void task.finally(() => {
      if (this.finishTask === task) this.finishTask = null;
    });
    return task;
  }

  private async save(generation: number) {
    if (!this.unsaved) return;
    await this.ports.save(this.unsaved);
    this.unsaved = null;
    if (generation === this.generation) {
      if (!this.prepared) {
        await this.ports.prepare();
        this.prepared = true;
      }
      if (generation === this.generation) this.change('ready');
    }
  }

  get canRetrySave() {
    return this.unsaved != null;
  }

  async retry() {
    if (this.phase !== 'failed') return;
    if (!this.unsaved) return this.prepare();
    this.change('saving');
    try {
      await this.save(this.generation);
    } catch (error) {
      this.change('failed', error);
    }
  }

  cancel() {
    this.generation++;
    this.held = false;
    this.prepared = false;
    this.ports.cancel();
  }

  interrupt(error: unknown) {
    this.cancel();
    this.change('failed', error);
  }

  /** Final exit discards a failed, unsaved take; an interruption keeps it available to retry. */
  dispose() {
    this.cancel();
    const discard = () => {
      if (this.unsaved) this.ports.discard?.(this.unsaved);
      this.unsaved = null;
    };
    if (this.finishTask) void this.finishTask.then(discard);
    else discard();
  }
}
