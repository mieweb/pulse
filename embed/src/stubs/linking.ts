import { Linking } from 'react-native';

/**
 * Embedded Pulse listens for no links: the host app owns them. Opening a URL (an upload's watch
 * link) or Settings goes through React Native's Linking, which needs no module of its own.
 */
export const openURL = (url: string): Promise<true> => Linking.openURL(url).then(() => true);

export const openSettings = (): Promise<void> => Linking.openSettings();

export const canOpenURL = (url: string): Promise<boolean> => Linking.canOpenURL(url);
