import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { setNetworkSource, type NetworkSource } from '@/core/network';

import {
  BLOCKED_MESSAGE,
  createCaptionsModelPolicy,
  embeddedPolicyOf,
  modelDownloadStep,
  STANDALONE_POLICY,
  takeGetsCaptions,
  type ModelPolicyDeps,
} from './model-policy';
import {
  getModel,
  getModelsBaseUrl,
  modelUrl,
  normalizeModelsBaseUrl,
  setModelsBaseUrl,
} from './models';

// The real modules reach the library and the native model files; the policy takes both injected.
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('@/db/settings', () => ({}));
jest.mock('./model-manager', () => ({}));

const PARAKEET = getModel('parakeet-tdt-0.6b-v3-q4_0')!;
const TURBO = getModel('large-v3-turbo-q5_0')!;

/** A network the test drives, fed through `@/core/network` as the embed's PulseKit source is. */
function network(online: boolean, wifi: boolean | null) {
  const subs = new Set<() => void>();
  const now = { online, wifi };
  const source: NetworkSource = {
    isOnline: () => now.online,
    isWifi: () => now.wifi,
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
  setNetworkSource(source);
  return (next: Partial<typeof now>) => {
    Object.assign(now, next);
    for (const cb of [...subs]) cb();
  };
}

/** A library and a models folder in memory. */
function fakeDeps(over: Partial<ModelPolicyDeps> = {}) {
  const store = { selected: null as string | null, autoDone: false, ready: new Set<string>() };
  const downloads: string[] = [];
  let fail: Error | null = null;
  const deps: ModelPolicyDeps = {
    selectedModelId: async () => store.selected,
    selectModel: async (id) => {
      store.selected = id;
    },
    isReady: (m) => store.ready.has(m.id),
    download: async (m) => {
      downloads.push(m.id);
      if (fail) throw fail;
      store.ready.add(m.id);
    },
    autoDone: async () => store.autoDone,
    markAutoDone: async () => {
      store.autoDone = true;
    },
    os: 'ios',
    ...over,
  };
  return { deps, store, downloads, failWith: (e: Error | null) => (fail = e) };
}

/** Let the policy's async steps run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const EMBED = { captions: {} };
const policy = embeddedPolicyOf(EMBED);

describe('modelDownloadStep', () => {
  const base = {
    policy,
    network: { online: true, wifi: true },
    modelReady: false,
    autoDone: false,
    declined: false,
  };

  it('downloads on Wi-Fi in the embed', () => {
    expect(modelDownloadStep(base)).toBe('download');
  });

  it('asks on cellular, and on a network that cannot say', () => {
    expect(modelDownloadStep({ ...base, network: { online: true, wifi: false } })).toBe('ask');
    expect(modelDownloadStep({ ...base, network: { online: true, wifi: null } })).toBe('ask');
    expect(
      modelDownloadStep({ ...base, network: { online: true, wifi: false }, declined: true }),
    ).toBe('none');
  });

  it('waits offline', () => {
    expect(modelDownloadStep({ ...base, network: { online: false, wifi: null } })).toBe('wait');
  });

  it('does nothing in the Pulse app, when turned off, once the model is there or once it ran', () => {
    expect(modelDownloadStep({ ...base, policy: STANDALONE_POLICY })).toBe('none');
    expect(
      modelDownloadStep({
        ...base,
        policy: embeddedPolicyOf({ captions: { autoDownload: 'never' } }),
      }),
    ).toBe('none');
    expect(modelDownloadStep({ ...base, modelReady: true })).toBe('none');
    expect(modelDownloadStep({ ...base, autoDone: true })).toBe('none');
  });
});

describe('embeddedPolicyOf', () => {
  it('defaults to downloading on Wi-Fi and captioning every take', () => {
    expect(embeddedPolicyOf({})).toEqual({
      embedded: true,
      autoDownload: 'wifi',
      autoGenerate: true,
    });
  });

  it('takes the host’s choices', () => {
    expect(embeddedPolicyOf({ captions: { autoDownload: 'never', autoGenerate: false } })).toEqual({
      embedded: true,
      autoDownload: 'never',
      autoGenerate: false,
    });
  });
});

describe('takeGetsCaptions', () => {
  it('captions every take in the embed until the person turns them off for the video', () => {
    expect(takeGetsCaptions(embeddedPolicyOf({}), false)).toBe(true);
    expect(takeGetsCaptions(embeddedPolicyOf({}), true)).toBe(false);
  });

  it('keeps the host’s autoGenerate: false whatever the switch says', () => {
    const off = embeddedPolicyOf({ captions: { autoGenerate: false } });
    expect(takeGetsCaptions(off, false)).toBe(false);
  });

  it('leaves the Pulse app as it is (no switch is ever set there)', () => {
    expect(takeGetsCaptions(STANDALONE_POLICY, false)).toBe(true);
  });
});

describe('the captions model policy', () => {
  afterEach(() => {
    setNetworkSource(null);
    setModelsBaseUrl(null);
  });

  let stops: (() => void)[] = [];
  beforeEach(() => {
    stops = [];
  });
  afterEach(() => stops.forEach((stop) => stop()));

  function started(deps: ModelPolicyDeps, config: object = EMBED) {
    const p = createCaptionsModelPolicy(deps);
    p.configure(config);
    stops.push(p.start());
    return p;
  }

  it('on Wi-Fi: downloads the default model once, selects it, and marks it done', async () => {
    network(true, true);
    const { deps, store, downloads } = fakeDeps();
    const p = started(deps);
    await settle();
    expect(downloads).toEqual([PARAKEET.id]);
    expect(store.selected).toBe(PARAKEET.id);
    expect(store.autoDone).toBe(true);
    expect(p.state()).toEqual({ kind: 'idle' });

    // The next open: nothing more to do, even after the person removed the model.
    store.ready.clear();
    stops.push(p.start());
    await settle();
    expect(downloads).toEqual([PARAKEET.id]);
  });

  it('downloads the selected model when there is one', async () => {
    network(true, true);
    const { deps, store, downloads } = fakeDeps();
    store.selected = TURBO.id;
    started(deps);
    await settle();
    expect(downloads).toEqual([TURBO.id]);
    expect(store.selected).toBe(TURBO.id);
  });

  it('does not hold up the open: start returns before the download ends', async () => {
    network(true, true);
    let finish!: () => void;
    const { deps } = fakeDeps({
      download: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    const p = createCaptionsModelPolicy(deps);
    p.configure(EMBED);
    const stop = p.start();
    stops.push(stop);
    expect(typeof stop).toBe('function');
    await settle();
    expect(p.state()).toMatchObject({ kind: 'downloading', model: PARAKEET });
    finish();
    await settle();
    expect(p.state()).toEqual({ kind: 'idle' });
  });

  it('on cellular: asks, and downloads only after "Download"', async () => {
    network(true, false);
    const { deps, downloads } = fakeDeps();
    const p = started(deps);
    await settle();
    expect(p.state()).toEqual({ kind: 'asking', model: PARAKEET });
    expect(downloads).toEqual([]);
    await p.accept();
    expect(downloads).toEqual([PARAKEET.id]);
    expect(p.state()).toEqual({ kind: 'idle' });
  });

  it('on cellular: "Not now" stops asking, and Wi-Fi later still downloads it', async () => {
    const setNet = network(true, false);
    const { deps, downloads } = fakeDeps();
    const p = started(deps);
    await settle();
    p.decline();
    expect(p.state()).toEqual({ kind: 'idle' });
    setNet({ wifi: null });
    await settle();
    expect(p.state()).toEqual({ kind: 'idle' });
    setNet({ wifi: true });
    await settle();
    expect(downloads).toEqual([PARAKEET.id]);
  });

  it('offline: waits, then downloads when Wi-Fi comes back', async () => {
    const setNet = network(false, null);
    const { deps, downloads } = fakeDeps();
    const p = started(deps);
    await settle();
    expect(p.state()).toEqual({ kind: 'waiting', model: PARAKEET });
    expect(downloads).toEqual([]);
    setNet({ online: true, wifi: true });
    await settle();
    expect(downloads).toEqual([PARAKEET.id]);
    expect(p.state()).toEqual({ kind: 'idle' });
  });

  it('blocked: a download that fails while online says the network blocked it', async () => {
    const setNet = network(true, true);
    const fake = fakeDeps();
    fake.failWith(new Error('HTTP 403 from proxy'));
    const p = started(fake.deps);
    await settle();
    expect(p.state()).toEqual({ kind: 'blocked', model: PARAKEET, message: BLOCKED_MESSAGE });
    expect(fake.store.autoDone).toBe(false);

    // Another network: it tries again, and the notice goes once the download works.
    fake.failWith(null);
    setNet({ wifi: true, online: true });
    await p.retry();
    expect(fake.downloads).toEqual([PARAKEET.id, PARAKEET.id]);
    expect(p.state()).toEqual({ kind: 'idle' });
  });

  it('a download cut off by going offline waits instead of saying blocked', async () => {
    const setNet = network(true, true);
    const { deps } = fakeDeps({
      download: async () => {
        setNet({ online: false, wifi: null });
        throw new Error('The network connection was lost.');
      },
    });
    const p = started(deps);
    await settle();
    expect(p.state()).toMatchObject({ kind: 'waiting' });
  });

  it('selects a model another account already put in the shared folder, without downloading', async () => {
    network(true, true);
    const { deps, store, downloads } = fakeDeps();
    store.ready.add(PARAKEET.id);
    started(deps);
    await settle();
    expect(downloads).toEqual([]);
    expect(store.selected).toBe(PARAKEET.id);
    expect(store.autoDone).toBe(true);
  });

  it('does nothing in the Pulse app (never configured), or when the host turns it off', async () => {
    network(true, true);
    const app = fakeDeps();
    const p = createCaptionsModelPolicy(app.deps);
    stops.push(p.start());
    await settle();
    expect(app.downloads).toEqual([]);
    expect(p.state()).toEqual({ kind: 'idle' });
    expect(p.autoGenerate()).toBe(true);
    expect(p.embedded()).toBe(false);
    expect(p.takeGetsCaptions(false)).toBe(true);

    const off = fakeDeps();
    const q = started(off.deps, { captions: { autoDownload: 'never', autoGenerate: false } });
    await settle();
    expect(off.downloads).toEqual([]);
    expect(off.store.selected).toBeNull();
    expect(q.autoGenerate()).toBe(false);
    expect(q.embedded()).toBe(true);
    expect(q.takeGetsCaptions(false)).toBe(false);
  });

  it('downloads from the host’s base URL', () => {
    const p = createCaptionsModelPolicy(fakeDeps().deps);
    p.configure({ models: { baseUrl: 'https://models.example.org/pulse/' } });
    expect(getModelsBaseUrl()).toBe('https://models.example.org/pulse');
    expect(modelUrl(PARAKEET)).toBe(
      'https://models.example.org/pulse/ggml-parakeet-tdt-0.6b-v3-q4_0.bin',
    );
    p.configure({});
    expect(modelUrl(PARAKEET)).toMatch(/^https:\/\/huggingface\.co\//);
  });

  it('keeps the built-in source for a base URL that is not absolute https', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const p = createCaptionsModelPolicy(fakeDeps().deps);
    p.configure({ models: { baseUrl: 'http://models.example.org' } });
    expect(getModelsBaseUrl()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('normalizeModelsBaseUrl', () => {
  it('takes an absolute https URL and drops a trailing slash', () => {
    expect(normalizeModelsBaseUrl('https://m.example.org')).toBe('https://m.example.org');
    expect(normalizeModelsBaseUrl(' https://m.example.org:8443/a/b// ')).toBe(
      'https://m.example.org:8443/a/b',
    );
  });

  it('refuses anything else', () => {
    for (const url of [
      'http://m.example.org',
      'm.example.org/models',
      '/models',
      'https://',
      'https://user:pw@m.example.org',
      'https://m.example.org/models?x=1',
      'https://m.example.org/#a',
      42,
      null,
    ]) {
      expect(normalizeModelsBaseUrl(url)).toBeNull();
    }
  });
});
