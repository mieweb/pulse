import * as Brownfield from 'expo-brownfield';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { setStorageRoots } from '@/utils/storage-root';

/**
 * What the host's PulseKit passes when it presents Pulse. Every open is one request: Pulse ends it
 * with one result, written to `<documentsDir>/results/<requestId>.json` before it messages the
 * host (`pulse.result`).
 */
type Props = {
  requestId?: string;
  entry?: string;
  /** Where Pulse keeps its library, inside the host's sandbox. */
  documentsDir?: string;
  cachesDir?: string;
};

const ROUTES: Record<string, string> = { full: 'pulsecam:///', record: 'pulsecam:///recorder' };

/** Set up this request, or say why it can't run. */
let mounts = 0;

function start(props: Props): string | null {
  const { requestId, entry = 'full', documentsDir, cachesDir } = props;
  console.log(`[embed] mount #${++mounts} request=${requestId} entry=${entry}`);
  if (!requestId || !documentsDir || !cachesDir) return 'Pulse was opened without its settings.';
  if (!(entry in ROUTES)) return `Pulse can't open “${entry}”.`;
  try {
    setStorageRoots({ documents: documentsDir, caches: cachesDir });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  // Loads the library: only now that its folder is set.
  const host = require('@/features/embed/host') as typeof import('@/features/embed/host');
  host.beginEmbedSession({
    requestId,
    entry: entry as 'full' | 'record',
    notify: (id) => Brownfield.sendMessage({ type: 'pulse.result', requestId: id }),
  });
  return null;
}

export function EmbedRoot(props: Props) {
  const [failure] = useState(() => start(props));
  useEffect(() => () => console.log(`[embed] unmount request=${props.requestId}`), [props.requestId]);
  if (failure) {
    console.log(`[embed] can't open: ${failure}`);
    return (
      <View style={styles.failure}>
        <Text style={styles.title}>Pulse couldn’t open</Text>
        <Text style={styles.message}>{failure}</Text>
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          onPress={() =>
            Brownfield.sendMessage({
              type: 'pulse.error',
              requestId: props.requestId ?? '',
              message: failure,
            })
          }>
          <Text style={styles.buttonLabel}>Close</Text>
        </Pressable>
      </View>
    );
  }
  const { PulseApp } = require('./pulse-app') as typeof import('./pulse-app');
  return <PulseApp url={ROUTES[props.entry ?? 'full']} />;
}

const styles = StyleSheet.create({
  failure: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, backgroundColor: '#fff' },
  title: { fontSize: 22, fontWeight: '600', color: '#000' },
  message: { fontSize: 17, color: '#3c3c43' },
  button: { alignSelf: 'flex-start', paddingVertical: 12 },
  buttonLabel: { fontSize: 17, color: '#007aff', fontWeight: '600' },
});
