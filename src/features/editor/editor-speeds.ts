import { getSetting } from '@/db/settings';

/**
 * The clip editor's speed menu: small bumps, since those are what people pick for talking-head
 * edits — usually 1.25x (#222). Custom speeds picked in the earlier editor (stored by older
 * versions) join the list.
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

export async function loadCustomSpeeds(): Promise<readonly number[]> {
  try {
    const parsed: unknown = JSON.parse((await getSetting(CUSTOM_SPEEDS_KEY)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isSpeed).slice(0, MAX_CUSTOM_SPEEDS) : [];
  } catch {
    return [];
  }
}
