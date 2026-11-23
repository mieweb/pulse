import * as Brownfield from 'expo-brownfield';
import { useEffect, useState, type ComponentType } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { setStorageRoots } from '@/utils/storage-root';

/**
 * The component PulseKit presents (module name "main"). Its initial props are the facade's
 * (native-bridge.md §8.1): the request, the folders inside the host's sandbox where Pulse keeps
 * its library, and the host's configuration. Every open is one request, and Pulse ends it with one
 * result.
 *
 * Rule 4: this file statically imports only the storage roots. The rest of the runtime opens the
 * library as its modules load, so it is required only once the roots point into the host's
 * sandbox. If that can't happen, the facade hears `pulse.error` and fails the flow.
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
};

type Runtime = ComponentType<Props & { requestId: string }>;
type Boot = { app: Runtime } | { failure: string };

let mounts = 0;

/** Set this request's folders, then load the runtime; or say why it can't run. */
function start(props: Props): Boot {
  const { requestId, documentsDir, cachesDir } = props;
  console.log(`[embed] mount #${++mounts} request=${requestId}`);
  if (props.headless) return { failure: 'This version of Pulse doesn’t start without a screen.' };
  if (!requestId || !documentsDir || !cachesDir) {
    return { failure: 'Pulse was opened without its settings.' };
  }
  try {
    setStorageRoots({ documents: documentsDir, caches: cachesDir });
    // Loads the library: only now that its folder is set.
    const { EmbedApp } = require('./shell/embed-app') as typeof import('./shell/embed-app');
    return { app: EmbedApp };
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

  useEffect(() => {
    if (failure === null) return;
    console.log(`[embed] can't open ${requestId}: ${failure}`);
    reportFailure(requestId, failure);
  }, [failure, requestId]);
  useEffect(() => () => console.log(`[embed] unmount request=${requestId}`), [requestId]);

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
