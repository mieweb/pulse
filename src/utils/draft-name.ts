/** Longest name a draft takes, in UTF-16 units (what a text input's `maxLength` counts). */
export const DRAFT_NAME_MAX_LENGTH = 40;

/**
 * A cut at a UTF-16 limit can end on the first half of an emoji's surrogate pair. That lone half
 * isn't valid text (it shows as "�"), so it's dropped rather than saved.
 */
export function dropSplitSurrogate(text: string): string {
  return text.replace(/[\uD800-\uDBFF]$/, '');
}
