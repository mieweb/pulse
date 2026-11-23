import * as Brownfield from 'expo-brownfield';
import { useEffect, useState, type ComponentType } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { setStorageRoots } from '@/utils/storage-root';

/**
 * The component PulseKit mounts (module name "main"). Its initial props are the facade's
 * (native-bridge.md §8.1): the request, the folders inside the host's sandbox where Pulse keeps
 * its library, the host's configuration and the network. Two kinds of root:
 *
 * - **A flow** (`request` set): every open is one request, and Pulse ends it with one result.
 * - **The command runtime** (`request: null`): PulseKit boots Pulse for a host write with no flow
 *   open. With `headless: true` (builds whose `headless` capability is on, S3) the root has no
 *   surface and draws nothing; otherwise PulseKit presents it and it shows "Preparing…" until the
 *   write is answered, then PulseKit closes it (AD5, O2).
 *
 * Either kind starts the runtime's services (commands/runtime.ts: the host's write commands, the
 * job loop, host requests, background uploads) once, for the runtime's life: later roots share
 * them, and they outlive each root.
 *
 * Rule 4: this file statically imports only the storage roots. The rest of the runtime opens the
 * library as its modules load, so it is required only once the roots point into the host's
 * sandbox. If that can't happen, the facade hears `pulse.error` and fails the flow (or the
 * writes waiting for the command runtime).
 */
type Props = {
  requestId?: string;
  request?: unknown;
  documentsDir?: string;
  cachesDir?: string;
  modelsDir?: string;
  namespace?: string;
  config?: unknown;
  headless?: boolean;
  network?: unknown;
};

type Runtime = ComponentType<Props & { requestId: string }>;
type Services = ReturnType<typeof import('./commands/runtime').startRuntimeServices>;
type Boot =
  | { app: Runtime; services: Services }
  | { commands: true; headless: boolean }
  | { failure: string };

let mounts = 0;

/** Point the library at the host's folders, then start the runtime's services (once). */
function startServices(props: Props, documentsDir: string, cachesDir: string): Services {
  setStorageRoots({ documents: documentsDir, caches: cachesDir });
  // Loads the library: only now that its folder is set.
  const runtime = require('./commands/runtime') as typeof import('./commands/runtime');
  return runtime.startRuntimeServices(props);
}

/** Set this root's folders, then load what it runs; or say why it can't run. */
function start(props: Props): Boot {
  const { requestId, documentsDir, cachesDir } = props;
  const commands = props.request == null;
  console.log(
    `[embed] mount #${++mounts} ` +
      (commands ? `commands${props.headless ? ' (headless)' : ''}` : `request=${requestId}`),
  );
  if (!documentsDir || !cachesDir || (!commands && !requestId)) {
    return { failure: 'Pulse was opened without its settings.' };
  }
  try {
    const services = startServices(props, documentsDir, cachesDir);
    if (commands) return { commands: true, headless: props.headless === true };
    const { EmbedApp } = require('./shell/embed-app') as typeof import('./shell/embed-app');
    return { app: EmbedApp, services };
  } catch (e) {
    return { failure: e instanceof Error ? e.message : String(e) };
  }
}

const reportFailure = (requestId: string | undefined, message: string) =>
  Brownfield.sendMessage({ type: 'pulse.error', requestId: requestId ?? '', message });

export function EmbedRoot(props: Props) {
  const [boot] = useState(() => start(props));
  const { requestId } = props;
  const failure = 'failure' in boot ? boot.failure : null;
  const services = 'app' in boot ? boot.services : null;

  useEffect(() => {
    if (failure === null) return;
    console.log(`[embed] can't open ${requestId || 'the command runtime'}: ${failure}`);
    reportFailure(requestId, failure);
  }, [failure, requestId]);
  // A flow is open from mount to unmount: the runtime isn't released under it (lifetime.ts).
  useEffect(() => services?.lifetime.flowOpened(), [services]);
  useEffect(() => () => console.log(`[embed] unmount request=${requestId}`), [requestId]);

  if ('commands' in boot) {
    if (boot.headless) return null;
    const { Preparing } = require('./shell/preparing') as typeof import('./shell/preparing');
    return <Preparing />;
  }
  if (!('app' in boot)) {
    // The facade dismisses Pulse on `pulse.error`; Close says it again if it didn't.
    return (
      <View style={styles.failure}>
        <Text style={styles.title} accessibilityRole="header">
          Pulse couldn’t open
        </Text>
        <Text style={styles.message}>{boot.failure}</Text>
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          onPress={() => reportFailure(requestId, boot.failure)}>
          <Text style={styles.buttonLabel}>Close</Text>
        </Pressable>
      </View>
    );
  }
  const App = boot.app;
  return <App {...props} requestId={requestId as string} />;
}

// Over the container's dark skeleton, whatever the theme: the theme isn't loaded here.
const styles = StyleSheet.create({
  failure: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, backgroundColor: '#000' },
  title: { fontSize: 22, fontWeight: '600', color: '#fff' },
  message: { fontSize: 17, color: '#ebebf5' },
  button: { alignSelf: 'flex-start', justifyContent: 'center', minHeight: 44 },
  buttonLabel: { fontSize: 17, color: '#0a84ff', fontWeight: '600' },
});
