/**
 * Embedded Pulse has no async-storage. The only reader is the one-time move of the old
 * async-storage library into SQLite, which an embedded library never had and `MigrationGate`
 * skips in embedded mode (B6). It reads as empty, so nothing would move if it ever ran.
 */
const AsyncStorage = {
  async getItem(): Promise<string | null> {
    return null;
  },
  async setItem(): Promise<void> {},
  async removeItem(): Promise<void> {},
  async getAllKeys(): Promise<readonly string[]> {
    return [];
  },
  async multiGet(): Promise<readonly [string, string | null][]> {
    return [];
  },
  async multiRemove(): Promise<void> {},
};

export default AsyncStorage;
