import { useEffect, useMemo, useState } from 'react';

import { checkCapabilities } from '@/features/upload/capabilities';
import { useDestinations } from '@/features/upload/use-destinations';
import { hostOf } from '@/utils/format';

import type { ServerCompat } from './details';

/**
 * Each paired server's compatibility with this app, checked live against its `/capabilities`
 * (the same check pairing runs) when the About page opens. One entry per server, even if it's
 * paired more than once.
 */
export function useServerCompatibility(): ServerCompat[] {
  const { destinations } = useDestinations();
  const servers = useMemo(
    () => [...new Set(destinations.map((d) => d.server))].sort(),
    [destinations],
  );
  const [results, setResults] = useState<Record<string, ServerCompat>>({});

  useEffect(() => {
    let cancelled = false;
    for (const server of servers) {
      void checkCapabilities(server).then((result) => {
        if (cancelled) return;
        const host = hostOf(server);
        const compat: ServerCompat = result.ok
          ? {
              server,
              host,
              status: 'compatible',
              minVersion: result.capabilities.minSupportedVersion,
              maxVersion: result.capabilities.maxSupportedVersion,
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
    (server) => results[server] ?? { server, host: hostOf(server), status: 'checking' },
  );
}
