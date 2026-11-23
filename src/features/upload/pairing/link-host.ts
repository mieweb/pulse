import Constants from 'expo-constants';

/**
 * Host of the https pairing links this build answers to (`extra.linkHost`, set in app.config.ts),
 * or `null` if the config carries none, and then only `pulsecam://` links pair.
 */
export const LINK_HOST: string | null = (() => {
  const host = (Constants.expoConfig?.extra as { linkHost?: unknown } | undefined)?.linkHost;
  return typeof host === 'string' && host ? host : null;
})();
