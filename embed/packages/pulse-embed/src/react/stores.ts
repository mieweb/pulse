import { toErrorInfo } from '../errors';
import type {
  CountOptions,
  DraftFilter,
  DraftSummary,
  FlowResult,
  Loadable,
  OpenRequest,
  PulseClient,
  PulseEventName,
  PulseEvents,
  PulseInfo,
} from '../types';

/**
 * The hooks' state, as small external stores for useSyncExternalStore. No React here, so jest
 * tests them directly. A store starts its work when the first subscriber attaches and stops
 * listening to the client when the last one leaves; its snapshot is a new object only when
 * something changed.
 */
export interface Store<S> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): S;
}

function createState<S>(initial: S, onFirst: () => void, onLast: () => void) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<S>) {
      state = { ...state, ...patch };
      for (const l of [...listeners]) l();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) onFirst();
      return () => {
        if (listeners.delete(listener) && listeners.size === 0) onLast();
      };
    },
  };
}

type Watch = {
  [E in PulseEventName]?: (payload: PulseEvents[E]) => boolean;
};

/**
 * A read that re-runs when the client reports a change. `watch` names the events that trigger a
 * re-read and, per event, whether this payload concerns the read. Re-reads don't pile up: while
 * one is running, any number of triggers make exactly one more run after it (uploadProgress comes
 * at up to 4/s per draft).
 */
export function createQueryStore<T>(
  client: Pick<PulseClient, 'on'>,
  load: () => Promise<T>,
  watch: Watch,
): Store<Loadable<T>> {
  let running = false;
  let again = false;
  let detach: (() => void)[] = [];

  async function run(): Promise<void> {
    if (running) {
      again = true;
      return;
    }
    running = true;
    if (!s.get().loading) s.set({ loading: true });
    do {
      again = false;
      try {
        const data = await load();
        s.set({ data, error: null, loading: again });
      } catch (e) {
        s.set({ error: toErrorInfo(e), loading: again });
      }
    } while (again);
    running = false;
  }

  const refresh = () => void run();

  const s = createState<Loadable<T>>(
    { data: undefined, loading: true, error: null, refresh },
    () => {
      detach = (Object.keys(watch) as PulseEventName[]).map((name) =>
        client.on(name, (payload: unknown) => {
          const concerns = watch[name] as ((p: unknown) => boolean) | undefined;
          if (!concerns || concerns(payload)) refresh();
        }),
      );
      refresh();
    },
    () => {
      for (const d of detach.splice(0)) d();
    },
  );
  return { subscribe: s.subscribe, getSnapshot: s.get };
}

const always = () => true;

/** useDrafts: `listDrafts(filter)`, re-read on draftsChanged and uploadProgress. */
export function createDraftsStore(
  client: Pick<PulseClient, 'on' | 'listDrafts'>,
  filter?: DraftFilter,
): Store<Loadable<DraftSummary[]>> {
  return createQueryStore(client, () => client.listDrafts(filter), {
    draftsChanged: always,
    uploadProgress: always,
  });
}

/** useDraft: `getDraft(id)`, re-read when an event names that draft. `null` reads nothing. */
export function createDraftStore(
  client: Pick<PulseClient, 'on' | 'getDraft'>,
  id: string | null,
): Store<Loadable<DraftSummary | null>> {
  if (id === null) {
    const fixed: Loadable<DraftSummary | null> = {
      data: null,
      loading: false,
      error: null,
      refresh: () => {},
    };
    return { subscribe: () => () => {}, getSnapshot: () => fixed };
  }
  return createQueryStore(client, () => client.getDraft(id), {
    draftsChanged: (p) => !Array.isArray(p.ids) || p.ids.includes(id),
    uploadProgress: (p) => p.draftId === id,
  });
}

/** useDraftCounts: `countDrafts(o)`, re-read on draftsChanged. */
export function createDraftCountsStore(
  client: Pick<PulseClient, 'on' | 'countDrafts'>,
  o: CountOptions,
): Store<Loadable<Record<string, number>>> {
  return createQueryStore(client, () => client.countDrafts(o), { draftsChanged: always });
}

export interface Availability {
  available: boolean;
  info: PulseInfo | null;
  loading: boolean;
}

/**
 * usePulseAvailability: `getInfo()` once. Not available on the web, without the plugin, when
 * `supported` is false, or for another contract major (getInfo rejects for those).
 */
export function createAvailabilityStore(client: Pick<PulseClient, 'getInfo'>): Store<Availability> {
  let started = false;
  const s = createState<Availability>(
    { available: false, info: null, loading: true },
    () => {
      if (started) return;
      started = true;
      client.getInfo().then(
        (info) => s.set({ available: info.supported === true, info, loading: false }),
        () => s.set({ available: false, info: null, loading: false }),
      );
    },
    () => {},
  );
  return { subscribe: s.subscribe, getSnapshot: s.get };
}

export interface PresentState {
  isOpen: boolean;
  lastResult: FlowResult | null;
}

export interface PresentStore extends Store<PresentState> {
  /** One flow at a time: while one is pending, another `open` gets the same pending result. */
  open(r: OpenRequest): Promise<FlowResult>;
}

/**
 * usePresent. `lastResult` is the latest result, from the `open` promise or from a `flowResult`
 * event (a result drained from the inbox after a reload).
 */
export function createPresentStore(client: Pick<PulseClient, 'open' | 'on'>): PresentStore {
  let pending: Promise<FlowResult> | null = null;
  let detach: (() => void) | null = null;
  const s = createState<PresentState>(
    { isOpen: false, lastResult: null },
    () => {
      detach = client.on('flowResult', (r) => s.set({ lastResult: r }));
    },
    () => {
      detach?.();
      detach = null;
    },
  );

  function open(r: OpenRequest): Promise<FlowResult> {
    if (pending) return pending;
    const p = client.open(r).then(
      (result) => {
        pending = null;
        s.set({ isOpen: false, lastResult: result });
        return result;
      },
      (e: unknown) => {
        pending = null;
        s.set({ isOpen: false });
        throw e;
      },
    );
    pending = p;
    s.set({ isOpen: true });
    return p;
  }

  return { subscribe: s.subscribe, getSnapshot: s.get, open };
}
