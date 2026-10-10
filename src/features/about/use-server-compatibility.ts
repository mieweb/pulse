import { useEffect, useMemo, useState } from 'react';

import { checkCapabilities } from '@/features/upload/capabilities';
import { useDestinations } from '@/features/upload/use-destinations';
import { displayServer } from '@/utils/format';

import type { ServerCompat } from './details';

/**
 * Each paired server's compatibility with this app, checked live against its `/capabilities`
 * (the same check pairing runs) when the destinations sheet or the About page opens, and again
 * when the set of paired servers changes. One entry per server, even if it's paired more than
 * once.
 */
export function useServerCompatibility(): ServerCompat[] {
  const { destinations } = useDestinations();
  // Keyed by the set of servers, not the list: `useDestinations` rebuilds its array on every
  // expiry tick, and depending on that would re-fetch every server's capabilities each tick.
  const serverKey = [...new Set(destinations.map((d) => d.server))].sort().join('\n');
  const servers = useMemo(() => (serverKey ? serverKey.split('\n') : []), [serverKey]);
  const [results, setResults] = useState<Record<string, ServerCompat>>({});

  useEffect(() => {
    let cancelled = false;
    for (const server of servers) {
      void checkCapabilities(server).then((result) => {
        if (cancelled) return;
        const host = displayServer(server);
        const compat: ServerCompat = result.ok
          ? {
              server,
              host,
              status: 'compatible',
              protocol: result.protocol,
              ...(result.capabilities.protocolRevision
                ? { revision: result.capabilities.protocolRevision }
                : {}),
            }
          : {
              server,
              host,
              status:
                result.reason === 'version-too-old'
                  ? 'app-too-old'
                  : result.reason === 'version-too-new'
                    ? 'app-too-new'
                    : 'unreachable',
            };
        setResults((prev) => ({ ...prev, [server]: compat }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [servers]);

  return servers.map(
    (server) => results[server] ?? { server, host: displayServer(server), status: 'checking' },
  );
}
