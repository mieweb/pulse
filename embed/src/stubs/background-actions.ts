/**
 * Embedded Pulse runs no foreground service. react-native-background-actions' Android service
 * casts the host's Application to a React Native one, which crashes in a Capacitor or Cordova app.
 * Uploads from an embedded Pulse run only while it's open.
 */
const BackgroundService = {
  async start(): Promise<void> {},
  async stop(): Promise<void> {},
  async updateNotification(): Promise<void> {},
};

export default BackgroundService;
