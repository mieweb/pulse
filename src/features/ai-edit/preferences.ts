import { getSetting, setSetting } from '@/db/settings';

import {
  DEFAULT_AI_EDIT_PROMPT,
  validateAiEditPrompt,
} from '../../../modules/expo-ai-editor/src/prompt';

const PROMPT_KEY = 'ai-edit.prompt';

/** The last used instructions, local to this app library. Older installs use the proven default. */
export async function loadAiEditPrompt(): Promise<string> {
  const saved = await getSetting(PROMPT_KEY);
  if (saved === null) return DEFAULT_AI_EDIT_PROMPT;
  try {
    return validateAiEditPrompt(saved);
  } catch {
    // Invalid restored/old settings cannot leave the developer editor unusable.
    return DEFAULT_AI_EDIT_PROMPT;
  }
}

/** Save only complete, valid instructions; never truncate a user's prompt silently. */
export async function saveAiEditPrompt(prompt: string): Promise<void> {
  await setSetting(PROMPT_KEY, validateAiEditPrompt(prompt));
}
