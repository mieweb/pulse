import * as Brownfield from 'expo-brownfield';

import { isOnline, setNetworkSource } from '@/core/network';
import { expoDb, library } from '@/db/client';
import { runMigrations } from '@/db/migrate';
import { installLogCapture } from '@/features/logs/logger';
import { listUploadJobs, subscribeUploadJobs } from '@/db/upload-jobs';
import { startCatalogWriter, stopCatalogWriter } from '@/features/drafts/catalog-writer';
import { clearClipQueue } from '@/features/transcription/clip-queue';
import { releaseVad } from '@/features/transcription/vad';
import { releaseWhisper } from '@/features/transcription/whisper';
import {
  hostRequestTimedOut,
  respondToHostRequest,
  setHostRequestSink,
} from '@/features/upload/core/host-services';
import { setBackgroundUploads } from '@/features/upload/core/native-chunk-upload';
import { createJobRunner, type JobRunner } from '@/features/upload/core/runner';

import { embedChannel } from '../shell/channel';
import { countActiveJobs, createLifetime, type Lifetime } from '../shell/lifetime';
import { createNetworkFeed } from '../shell/messaging';
import { heldDraft } from './held-draft';
import { connectHostRequests } from './host-requests';
import { libraryDeps } from './library';
import { commandHandlers, routeCommands } from './router';
import { brownfieldUploadTransport } from './upload-transport';

/**
 * Pulse JS's services for the life of the embedded runtime, started by the first root that mounts
 * (a flow, the headless root, or the "Preparing…" root) once the storage roots are set, whichever
 * comes first, and never twice: the roots that follow share them. They outlive every root, so a
 * Send queued in a flow goes on uploading after Pulse closes, and a host write sent with nothing
 * presented finds its handler.
 *
 * In order:
 * 1. the network source, seeded from the initial props' `network` before anything reads it, then
 *    fed by `pulse.cmd network` (PulseKit's NWPathMonitor, Q6);
 * 2. host requests over the channel (setHostRequestSink → `hostRequest` events, `pulse.respond`
 *    → respondToHostRequest, `pulse.cmd hostTimeout` → hostRequestTimedOut);
 * 3. PATCHes in PulseKit's background session (`setBackgroundUploads` over BrownfieldMessaging's
 *    `pulse.upload` messages, O16);
 * 4. the host's write commands (commands/router.ts), and `pulse.ready` so PulseKit sends them; each
 *    waits for the library gate below;
 * 5. the library gate (the migrations, as PulseCore's gate runs them, without its screens), then
 *    catalog.json and the job loop with the launch rule (§6.3).
 *
 * Internal commands: `configure` (the host's latest `configure` options, sent by PulseKit when the
 * runtime is up and again on every `pulse.ready`: commands read `uploadMode` from them per call, not
 * from the props of whichever root booted the runtime), `accountActive {active}` (setAccount /
 * sign-out: the runner pauses while its namespace isn't the signed-in one), `releaseLibrary` (a
 * purge of this namespace: stop and close the database for good) and `memoryWarning` (lifetime.ts).
 * Once the library is let go, for either reason, Pulse JS says `pulse.released`: PulseKit then
 * never sends this runtime another command, and starts a fresh one for whatever comes next.
 */

export type RuntimeProps = { namespace?: string; config?: unknown; network?: unknown };

export type RuntimeServices = { readonly namespace: string; readonly lifetime: Lifetime };

let services: RuntimeServices | null = null;

/** Start the services for `props.namespace` (once per runtime); null without a namespace. */
export function startRuntimeServices(props: RuntimeProps): RuntimeServices | null {
  if (services) return services;
  if (!props.namespace) return null;
  services = createServices(props.namespace, props);
  return services;
}

/** A coded error the channel replies with (messaging.ts `errorInfo`). */
const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

export function uploadModeOf(config: unknown): 'pulse' | 'file' {
  const mode = (config as { uploadMode?: unknown } | null | undefined)?.uploadMode;
  return mode === 'file' ? 'file' : 'pulse';
}

function createServices(namespace: string, props: RuntimeProps): RuntimeServices {
  const channel = embedChannel();
  const log = (line: string) => console.log(`[embed] ${line}`);
  // The host's configure options: the booting root's, then each `pulse.cmd configure`.
  let config: unknown = props.config;
  const stops: (() => void)[] = [];
  let runner: JobRunner | null = null;
  let accountActive = true;
  let released = false;

  const lifetime = createLifetime({
    activeJobs: () => (released ? 0 : countActiveJobs(listUploadJobs().map((j) => j.state))),
    async releaseEngines() {
      await clearClipQueue();
      await releaseWhisper();
      await releaseVad();
    },
    releaseLibrary,
    now: () => Date.now(),
    log,
  });
  lifetime.mark('runtime');

  // catalog.json first, then `draftsChanged`: a host that reads on the event sees the change.
  async function changed(ids: readonly string[]): Promise<void> {
    if (released || ids.length === 0) return;
    await startCatalogWriter({ namespace, online: isOnline }); // a later start writes it again
    channel.event('draftsChanged', { namespace, ids: [...ids] });
  }
  const jobChanges = new Set<string>();
  // Job notices in one burst go out together. A microtask, not a timer: on Android, timers are
  // paused while no Pulse screen is resumed, which is when background uploads finish.
  let jobsQueued = false;
  const jobsChanged = (ids: readonly string[]) => {
    ids.forEach((id) => jobChanges.add(id));
    if (jobsQueued) return;
    jobsQueued = true;
    queueMicrotask(() => {
      jobsQueued = false;
      const batch = [...jobChanges];
      jobChanges.clear();
      void changed(batch).catch((e: unknown) => log(`draftsChanged not sent: ${String(e)}`));
    });
  };

  // 1. The network, before the job loop reads it.
  const network = createNetworkFeed(props.network);
  setNetworkSource(network.source);
  stops.push(
    channel.handle('network', (args) => {
      network.update(args);
      return null;
    }),
  );

  stops.push(
    channel.handle('configure', (args) => {
      config = args;
      return null;
    }),
  );

  // 2. Host requests.
  stops.push(
    connectHostRequests(channel, { setHostRequestSink, respondToHostRequest, hostRequestTimedOut }),
  );

  // 3. PATCHes in PulseKit's background session.
  setBackgroundUploads(
    brownfieldUploadTransport({
      sendMessage: (message) => Brownfield.sendMessage(message),
      addMessageListener: (listener) => Brownfield.addMessageListener(listener),
    }),
  );

  // 5. The library gate, then the catalog and the job loop.
  const ready = (async () => {
    if (library.failed) throw coded('storage.damaged', 'Pulse’s library couldn’t be opened.');
    try {
      await runMigrations('embedded');
    } catch (e) {
      throw coded('storage.damaged', `Pulse couldn’t update its library: ${String(e)}`);
    }
    if (released) return;
    // Headless and "Preparing…" roots skip PulseCore's onBoot, so logFile gets the job loop's
    // logs only if this runtime installs the capture too (idempotent).
    installLogCapture();
    lifetime.mark('library');
    await startCatalogWriter({ namespace, online: isOnline });
    if (released) return;
    const loop = createJobRunner();
    runner = loop;
    stops.push(
      loop.subscribeProgress((p) =>
        channel.event('uploadProgress', {
          draftId: p.draftId,
          fraction: p.bytesTotal > 0 ? Math.min(1, p.bytesSent / p.bytesTotal) : 0,
          bytesSent: p.bytesSent,
          bytesTotal: p.bytesTotal,
        }),
      ),
    );
    stops.push(subscribeUploadJobs(jobsChanged));
    loop.setAccountActive(accountActive);
    stops.push(loop.start());
    await loop.boot();
    lifetime.mark('outbox');
  })();
  ready.catch((e: unknown) => log(`the runtime's library isn't usable: ${String(e)}`));

  // 4. The host's writes.
  const deps = libraryDeps({
    runner: () => runner,
    heldDraft,
    uploadMode: () => uploadModeOf(config),
    changed,
  });
  stops.push(
    routeCommands(channel, commandHandlers(deps), (method, run) =>
      lifetime.track(async () => {
        if (released) throw coded('busy', 'Pulse let go of its library; try again.');
        await ready;
        lifetime.mark('command');
        log(`command ${method}`);
        return run();
      }),
    ),
  );
  stops.push(
    channel.handle('accountActive', (args) => {
      accountActive = args.active !== false;
      runner?.setAccountActive(accountActive);
      return null;
    }),
  );
  stops.push(
    channel.handle('releaseLibrary', async () => {
      if (lifetime.load().flowsOpen > 0) throw coded('busy', 'A flow is open.');
      await releaseLibrary();
      return null;
    }),
  );
  stops.push(channel.handle('memoryWarning', () => lifetime.memoryWarning()));

  /**
   * Let go of the library for good (a purge of this namespace, or an idle runtime on a memory
   * warning): the job loop stops, nothing more is written, and the database closes. PulseKit then
   * starts a fresh runtime for whatever comes next.
   */
  async function releaseLibrary(): Promise<void> {
    if (released) return;
    released = true;
    runner?.setAccountActive(false);
    await ready.catch(() => {});
    runner?.setAccountActive(false);
    for (const stop of stops.splice(0)) stop();
    jobChanges.clear();
    setBackgroundUploads(null);
    setNetworkSource(null);
    // Nothing below may stop `pulse.released`: the handlers are gone already, so PulseKit must
    // hear that this runtime takes no more commands.
    try {
      await stopCatalogWriter();
    } catch (e) {
      log(`catalog.json's writer didn't stop cleanly: ${String(e)}`);
    }
    try {
      expoDb.closeSync();
    } catch (e) {
      log(`the library didn't close cleanly: ${String(e)}`);
    }
    log(`released the library of ${namespace}`);
    channel.released(namespace);
  }

  channel.ready(namespace);
  return { namespace, lifetime };
}
