import {
  AI_EDIT_PROMPT_PRESETS,
  DEFAULT_AI_EDIT_PROMPT,
} from '../../../modules/expo-ai-editor/src/prompt';

export type PromptEditorState = { text: string; loading: boolean; edited: boolean };
export type PromptEditorAction =
  { type: 'loaded'; prompt: string } | { type: 'load-failed' } | { type: 'edit'; prompt: string };

export function initialPromptEditorState(): PromptEditorState {
  return { text: DEFAULT_AI_EDIT_PROMPT, loading: true, edited: false };
}

/** A delayed local preference read must never replace text the person has already chosen. */
export function promptEditorReducer(
  state: PromptEditorState,
  action: PromptEditorAction,
): PromptEditorState {
  if (action.type === 'edit') return { ...state, text: action.prompt, edited: true };
  if (action.type === 'load-failed') return { ...state, loading: false };
  return { ...state, text: state.edited ? state.text : action.prompt, loading: false };
}

/** Editing a preset becomes Custom as soon as its actual instructions differ. */
export function presetForPrompt(prompt: string) {
  return AI_EDIT_PROMPT_PRESETS.find((preset) => preset.prompt === prompt.trim()) ?? null;
}
