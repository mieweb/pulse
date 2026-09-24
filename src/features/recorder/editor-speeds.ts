import { getSetting, setSetting } from '@/db/settings';

/**
 * The clip editor's speed menu. RNVT's stock list (0.25–4x) is too coarse for talking-head
 * edits, where small bumps are what people actually pick — usually 1.25x (#222). Anything else
 * is one "Custom…" away in the editor, and recent custom picks join this list (below).
 */
export const EDITOR_SPEEDS: readonly number[] = [0.5, 1, 1.1, 1.2, 1.25, 1.3, 1.5, 2];

const CUSTOM_SPEEDS_KEY = 'editor.customSpeeds';
const MAX_CUSTOM_SPEEDS = 3;

const sameSpeed = (a: number, b: number) => Math.abs(a - b) < 0.0001;
const isSpeed = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0.25 && v <= 4;

/** The menu for the editor: the standard speeds plus the user's recent custom ones, ascending. */
export function speedMenu(custom: readonly number[]): number[] {
  const all = [...EDITOR_SPEEDS];
  for (const speed of custom) if (!all.some((s) => sameSpeed(s, speed))) all.push(speed);
  return all.sort((a, b) => a - b);
}

/**
 * Remember `speed` as a recent custom pick (most recent first, capped). Returns `custom` itself
 * when nothing changes — a standard speed, an already-latest pick, or no speed at all.
 */
export function withCustomSpeed(
  custom: readonly number[],
  speed: number | null,
): readonly number[] {
  if (speed === null || !isSpeed(speed) || EDITOR_SPEEDS.some((s) => sameSpeed(s, speed))) {
    return custom;
  }
  if (custom.length > 0 && sameSpeed(custom[0], speed)) return custom;
  return [speed, ...custom.filter((s) => !sameSpeed(s, speed))].slice(0, MAX_CUSTOM_SPEEDS);
}

/**
 * The speed recorded in an RNVT `editState`. The string is opaque to the app everywhere else;
 * this one read is best-effort, and anything unexpected just means "no custom speed".
 */
export function editStateSpeed(editState: string | null): number | null {
  if (!editState) return null;
  try {
    const speed: unknown = JSON.parse(editState)?.speed;
    return isSpeed(speed) ? speed : null;
  } catch {
    return null;
  }
}

export async function loadCustomSpeeds(): Promise<readonly number[]> {
  try {
    const parsed: unknown = JSON.parse((await getSetting(CUSTOM_SPEEDS_KEY)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isSpeed).slice(0, MAX_CUSTOM_SPEEDS) : [];
  } catch {
    return [];
  }
}

export async function saveCustomSpeeds(custom: readonly number[]): Promise<void> {
  await setSetting(CUSTOM_SPEEDS_KEY, JSON.stringify(custom));
}
