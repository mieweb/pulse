/**
 * Import lines for the debug log (About → Share logs), tagged `[import]` so a failed import can
 * be diagnosed from a shared log: what was picked, what the policy decided and why, which engine
 * converted it (and any fallback), how long it took, and the real error when it fails.
 * One line per step or outcome.
 */
export const importLog = {
  info: (message: string) => console.info(`[import] ${message}`),
  warn: (message: string) => console.warn(`[import] ${message}`),
};
