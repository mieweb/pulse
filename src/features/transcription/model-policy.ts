import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { isOnline, isWifi, subscribeNetwork } from '@/core/network';
import { getSetting, selectedModelQuery, setSelectedModel, setSetting } from '@/db/settings';

import { downloadModel, isModelReady } from './model-manager';
import { modelsFor, resolveSelectedModel, setModelsBaseUrl, type WhisperModel } from './models';

/**
 * When the captions model downloads in the embed (O6, C8). Captions are on in a host app, and they
 * need a 100+ MB on-device model, so the embed doesn't wait for the person to download it from the
 * captions sheet as the Pulse app does:
 *
 * - On Wi-Fi it downloads the model once, the first time Pulse opens in the host (the selected
 *   one, or the platform's default, which it then selects). Every take then gets captions
 *   (`autoGenerate`), as clips are transcribed between takes.
 * - On cellular (or a network that can't say) it asks first.
 * - Offline it waits, and tries once the network is back.
 * - A download that fails while online shows "Captions need a download that your network
 *   blocked". Recording is never held up: nothing waits for the download.
 *
 * The host can turn the automatic download off (`configure({captions: {autoDownload: 'never'}})`)
 * and point the downloads at its own mirror (`configure({models: {baseUrl}})`). The Pulse app
 * never configures it, so none of this runs there. Wi-Fi comes from `@/core/network`, which the
 * embed feeds from PulseKit's network events.
 */

export type CaptionsPolicy = {
  /** Set by the embed's `configureCaptions`; the Pulse app keeps today's manual download. */
  embedded: boolean;
  /** 'wifi' (default): download on Wi-Fi without asking, ask on cellular. 'never': the sheet only. */
  autoDownload: 'wifi' | 'never';
  /** Default true: every take gets captions (the clips are transcribed between takes). */
  autoGenerate: boolean;
};

/** The Pulse app's policy: no automatic download; takes get captions once a model is there. */
export const STANDALONE_POLICY: CaptionsPolicy = {
  embedded: false,
  autoDownload: 'never',
  autoGenerate: true,
};

/** What the host configured (`ConfigureOptions`' `models` and `captions`), as Pulse reads it. */
export type CaptionsConfig = {
  models?: { baseUrl?: unknown } | null;
  captions?: { autoDownload?: unknown; autoGenerate?: unknown } | null;
};

/** The embed's policy from the host's configuration, its defaults filled in. */
export function embeddedPolicyOf(config: CaptionsConfig): CaptionsPolicy {
  const captions = config.captions ?? {};
  return {
    embedded: true,
    autoDownload: captions.autoDownload === 'never' ? 'never' : 'wifi',
    autoGenerate: captions.autoGenerate !== false,
  };
}

export type NetworkNow = { online: boolean; wifi: boolean | null };

/** What to do about the model now. */
export type ModelStep = 'none' | 'download' | 'ask' | 'wait';

/**
 * The rule: nothing in the Pulse app, with the download turned off, once the model is on the
 * phone or once the automatic download has run (`autoDone`; a model the person removed stays
 * removed). Otherwise offline → wait; Wi-Fi → download; anything else → ask, unless the person
 * said "Not now" this session.
 */
export function modelDownloadStep(input: {
  policy: CaptionsPolicy;
  network: NetworkNow;
  modelReady: boolean;
  autoDone: boolean;
  declined: boolean;
}): ModelStep {
  const { policy, network, modelReady, autoDone, declined } = input;
  if (!policy.embedded || policy.autoDownload === 'never' || modelReady || autoDone) return 'none';
  if (!network.online) return 'wait';
  if (network.wifi === true) return 'download';
  return declined ? 'none' : 'ask';
}

export const BLOCKED_MESSAGE = 'Captions need a download that your network blocked';

export type CaptionsModelState =
  | { kind: 'idle' }
  /** Offline: it tries when the network is back. */
  | { kind: 'waiting'; model: WhisperModel }
  /** On cellular: the recorder asks before downloading. */
  | { kind: 'asking'; model: WhisperModel }
  | { kind: 'downloading'; model: WhisperModel }
  /** The download failed while online: the network (or a proxy) blocked it. */
  | { kind: 'blocked'; model: WhisperModel; message: string };

/** What the policy reads and writes, injected so the rule runs without a phone in tests. */
export type ModelPolicyDeps = {
  /** The stored selection's id, or null. */
  selectedModelId: () => Promise<string | null>;
  selectModel: (id: string) => Promise<void>;
  isReady: (model: WhisperModel) => boolean;
  /** Download the weights; rejects when it fails. */
  download: (model: WhisperModel) => Promise<void>;
  /** Whether the automatic download already ran on this library. */
  autoDone: () => Promise<boolean>;
  markAutoDone: () => Promise<void>;
  /** `Platform.OS`, for the default model. */
  os: string;
};

export type CaptionsModelPolicy = ReturnType<typeof createCaptionsModelPolicy>;

export function createCaptionsModelPolicy(deps: ModelPolicyDeps) {
  let policy: CaptionsPolicy = STANDALONE_POLICY;
  let state: CaptionsModelState = { kind: 'idle' };
  let declined = false;
  /** "Download" on the cellular question: off Wi-Fi is fine for the rest of the session. */
  let cellularOk = false;
  let running: Promise<void> | null = null;
  let again = false;
  let starts = 0;
  let stopNetwork: (() => void) | null = null;
  const listeners = new Set<() => void>();

  const set = (next: CaptionsModelState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  /** The model the download is for: the selection, else (before the first run) the default. */
  async function target(
    autoDone: boolean,
  ): Promise<{ model: WhisperModel; selected: boolean } | null> {
    const selected = resolveSelectedModel(await deps.selectedModelId(), deps.os);
    if (selected) return { model: selected, selected: true };
    const fallback = autoDone ? null : (modelsFor(deps.os)[0] ?? null);
    return fallback ? { model: fallback, selected: false } : null;
  }

  async function download(model: WhisperModel, selected: boolean): Promise<void> {
    set({ kind: 'downloading', model });
    try {
      if (!selected) await deps.selectModel(model.id);
      await deps.download(model);
      await deps.markAutoDone();
      set({ kind: 'idle' });
    } catch (e) {
      console.warn(`[captions] the model download failed: ${String(e)}`);
      set(
        isOnline()
          ? { kind: 'blocked', model, message: BLOCKED_MESSAGE }
          : { kind: 'waiting', model },
      );
    }
  }

  /**
   * Look at the model and the network, and act. One run at a time: a call during a run makes it
   * look again once it's done, and resolves with that run.
   */
  function evaluate(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await step();
        } while (again);
      } catch (e) {
        console.warn(`[captions] the model policy failed: ${String(e)}`);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function step(): Promise<void> {
    if (!policy.embedded) return;
    const done = await deps.autoDone();
    const picked = await target(done);
    if (!picked) {
      set({ kind: 'idle' });
      return;
    }
    const { model, selected } = picked;
    const modelReady = deps.isReady(model);
    // Already on the phone (the person downloaded it, or another account did; the models folder
    // is shared): selected, so takes get captions, and counted as the one automatic download, so
    // removing it later keeps it removed.
    if (modelReady && !done && policy.autoDownload !== 'never') {
      if (!selected) await deps.selectModel(model.id);
      await deps.markAutoDone();
    }
    const next = modelDownloadStep({
      policy,
      network: { online: isOnline(), wifi: isWifi() },
      modelReady,
      autoDone: done,
      declined,
    });
    if (next === 'download' || (next === 'ask' && cellularOk)) await download(model, selected);
    else if (next === 'ask') set({ kind: 'asking', model });
    else if (next === 'wait') set({ kind: 'waiting', model });
    // 'none': a blocked download stays on show until something changes it.
    else if (state.kind !== 'blocked' || modelReady) set({ kind: 'idle' });
  }

  return {
    /**
     * The embed's configuration (every open passes it): the policy and the models' base URL.
     * An invalid base URL keeps the built-in sources, with a warning.
     */
    configure(config: CaptionsConfig): void {
      policy = embeddedPolicyOf(config);
      const baseUrl = config.models?.baseUrl;
      if (!setModelsBaseUrl(typeof baseUrl === 'string' ? baseUrl : null) && baseUrl != null) {
        console.warn('[captions] models.baseUrl must be an absolute https URL; using the default');
      }
    },
    /** Whether takes get captions on their own (the recorder's clip transcription). */
    autoGenerate(): boolean {
      return policy.autoGenerate;
    },
    /**
     * Start following the network and act on the model now. Each open starts it once and stops
     * it as it closes; it keeps running while any open does. The returned function stops it.
     */
    start(): () => void {
      starts++;
      if (starts === 1) stopNetwork = subscribeNetwork(() => void evaluate());
      void evaluate();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        starts--;
        if (starts === 0) {
          stopNetwork?.();
          stopNetwork = null;
        }
      };
    },
    /** "Download" on the cellular question: download it on this network. */
    accept(): Promise<void> {
      cellularOk = true;
      declined = false;
      return evaluate();
    },
    /** "Not now": no more asking this session (Wi-Fi still downloads it). */
    decline(): void {
      declined = true;
      if (state.kind === 'asking') set({ kind: 'idle' });
    },
    /** Look again now (e.g. "Try again" on the blocked state). */
    retry(): Promise<void> {
      return evaluate();
    },
    state(): CaptionsModelState {
      return state;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Settings key: the automatic download ran on this library. */
const AUTO_DOWNLOAD_DONE_KEY = 'transcription.autoDownloaded';

/** The runtime's one policy, on the library's settings and the model files. */
export const captionsModelPolicy = createCaptionsModelPolicy({
  selectedModelId: async () => (await selectedModelQuery)[0]?.value ?? null,
  selectModel: (id) => setSelectedModel(id),
  isReady: (model) => isModelReady(model),
  download: (model) => downloadModel(model),
  autoDone: async () => (await getSetting(AUTO_DOWNLOAD_DONE_KEY)) === 'true',
  markAutoDone: () => setSetting(AUTO_DOWNLOAD_DONE_KEY, 'true'),
  os: Platform.OS,
});

/** The embed's `configure` options for captions (`models`, `captions`). */
export const configureCaptions = (config: CaptionsConfig) => captionsModelPolicy.configure(config);

/** Start the policy for one open (the embed, under the library gate); returns its stop. */
export const startCaptionsModelPolicy = () => captionsModelPolicy.start();

/** The policy's state, for the recorder's notice. */
export function useCaptionsModelState(): CaptionsModelState {
  return useSyncExternalStore(
    captionsModelPolicy.subscribe,
    captionsModelPolicy.state,
    captionsModelPolicy.state,
  );
}

/** The question on cellular, with the model's size. */
export function askText(model: WhisperModel): string {
  const mb = Math.round(model.approxBytes / (1024 * 1024));
  return `Download captions? The captions model is ${mb} MB, and you’re not on Wi-Fi.`;
}
