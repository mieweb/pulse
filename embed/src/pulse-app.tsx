import { ExpoRoot } from 'expo-router';

/**
 * The Pulse app's own screens (../src/app), mounted at `url`. Loaded only after the storage roots
 * are set: the screens' modules open the library when they load.
 */
const routes = require.context(
  '../../src/app',
  true,
  /^(?:\.\/)(?!(?:(?:(?:.*\+api)|(?:\+html)|(?:\+middleware)))\.[tj]sx?$).*(?:\.android|\.ios)?\.[tj]sx?$/,
);

export function PulseApp({ url }: { url: string }) {
  return (
    <ExpoRoot
      context={routes}
      linking={{
        getInitialURL: () => url,
        // The host app owns its links: none reach an embedded Pulse.
        subscribe: () => () => {},
      }}
    />
  );
}
