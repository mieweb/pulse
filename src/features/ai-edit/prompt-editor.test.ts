import { describe, expect, it } from '@jest/globals';

import {
  AI_EDIT_PROMPT_PRESETS,
  DEFAULT_AI_EDIT_PROMPT,
} from '../../../modules/expo-ai-editor/src/prompt';
import { initialPromptEditorState, presetForPrompt, promptEditorReducer } from './prompt-editor';

describe('AI instruction configuration', () => {
  it('prefills the known working default and applies a saved preference only before editing', () => {
    const initial = initialPromptEditorState();
    expect(initial.text).toBe(DEFAULT_AI_EDIT_PROMPT);
    expect(initial.loading).toBe(true);
    expect(promptEditorReducer(initial, { type: 'loaded', prompt: 'Keep the decisions.' })).toEqual(
      {
        text: 'Keep the decisions.',
        loading: false,
        edited: false,
      },
    );
  });

  it('keeps custom typing when a slower saved-preference read resolves', () => {
    const typed = promptEditorReducer(initialPromptEditorState(), {
      type: 'edit',
      prompt: 'My current instructions',
    });
    expect(
      promptEditorReducer(typed, { type: 'loaded', prompt: 'Older saved instructions' }),
    ).toEqual({
      text: 'My current instructions',
      loading: false,
      edited: true,
    });
  });

  it('protects a preset or Reset choice from a late load and clears loading after read failure', () => {
    const selected = promptEditorReducer(initialPromptEditorState(), {
      type: 'edit',
      prompt: AI_EDIT_PROMPT_PRESETS[1].prompt,
    });
    expect(
      promptEditorReducer(selected, { type: 'loaded', prompt: 'Older custom instructions' }).text,
    ).toBe(AI_EDIT_PROMPT_PRESETS[1].prompt);
    const reset = promptEditorReducer(selected, { type: 'edit', prompt: DEFAULT_AI_EDIT_PROMPT });
    expect(
      promptEditorReducer(reset, { type: 'loaded', prompt: 'Older custom instructions' }).text,
    ).toBe(DEFAULT_AI_EDIT_PROMPT);
    expect(promptEditorReducer(selected, { type: 'load-failed' })).toMatchObject({
      text: AI_EDIT_PROMPT_PRESETS[1].prompt,
      loading: false,
    });
  });

  it('matches a style by its visible text and labels edited instructions as Custom', () => {
    for (const preset of AI_EDIT_PROMPT_PRESETS)
      expect(presetForPrompt(preset.prompt)?.id).toBe(preset.id);
    expect(presetForPrompt(`  ${DEFAULT_AI_EDIT_PROMPT}\n`)?.id).toBe('default');
    expect(presetForPrompt(`${DEFAULT_AI_EDIT_PROMPT} Emphasize risks.`)).toBeNull();
    expect(presetForPrompt('')).toBeNull();
  });
});
