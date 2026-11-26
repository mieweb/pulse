/** The successful original editorial prompt, shared by the UI and native wrapper. */
export const DEFAULT_AI_EDIT_PROMPT = `You are editing a spoken video into a concise, coherent extract. Choose existing passages
that preserve the speaker's central message, necessary context, qualifications and conclusion.
Omit repetition, tangents and filler. Do not rewrite or invent speech.`;

/** JavaScript string length and Swift utf16.count both measure UTF-16 code units. */
export const MAX_AI_EDIT_PROMPT_LENGTH = 2000;

export function validateAiEditPrompt(value: string): string {
  const prompt = typeof value === 'string' ? value.trim() : '';
  if (!prompt) throw new Error('Enter instructions for the AI edit.');
  if (prompt.length > MAX_AI_EDIT_PROMPT_LENGTH)
    throw new Error('Keep AI editing instructions to 2,000 characters or fewer.');
  return prompt;
}

export type AiEditPromptPreset = {
  id: 'default' | 'highlights' | 'work-update' | 'story';
  label: string;
  prompt: string;
};

export const AI_EDIT_PROMPT_PRESETS: readonly AiEditPromptPreset[] = [
  { id: 'default', label: 'Default', prompt: DEFAULT_AI_EDIT_PROMPT },
  {
    id: 'highlights',
    label: 'Highlights',
    prompt:
      "Create a punchy highlight reel from the speaker's original words. Prioritize the strongest takeaways, memorable statements and concrete examples; remove repetition, digressions and filler. Preserve necessary context, qualifications and the speaker's meaning. Do not rewrite or invent speech.",
  },
  {
    id: 'work-update',
    label: 'Work update',
    prompt:
      "Create a concise work update from the speaker's original words. Prioritize progress, decisions, blockers and next steps, including owners and dates when they are actually stated. Preserve context and qualifications; omit repetition and tangents. Do not rewrite or invent speech.",
  },
  {
    id: 'story',
    label: 'Story',
    prompt:
      "Create a concise story from the speaker's original words. Favor a clear setup, the central problem or turning point, and the outcome or lesson. Retain the context needed to connect those beats and preserve the speaker's meaning. Omit repetition and tangents. Do not rewrite or invent speech.",
  },
];
