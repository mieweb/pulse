import { describe, expect, it } from '@jest/globals';

import {
  AI_EDIT_PROMPT_PRESETS,
  DEFAULT_AI_EDIT_PROMPT,
  MAX_AI_EDIT_PROMPT_LENGTH,
  validateAiEditPrompt,
} from './prompt';

describe('AI editorial instructions', () => {
  it('preserves the successful original editorial instructions as the default', () => {
    expect(DEFAULT_AI_EDIT_PROMPT).toBe(
      "You are editing a spoken video into a concise, coherent extract. Choose existing passages\nthat preserve the speaker's central message, necessary context, qualifications and conclusion.\nOmit repetition, tangents and filler. Do not rewrite or invent speech.",
    );
    expect(AI_EDIT_PROMPT_PRESETS.find((preset) => preset.id === 'default')?.prompt).toBe(
      DEFAULT_AI_EDIT_PROMPT,
    );
  });

  it('provides the four distinct presets as valid editable text', () => {
    expect(AI_EDIT_PROMPT_PRESETS.map((preset) => preset.id)).toEqual([
      'default',
      'highlights',
      'work-update',
      'story',
    ]);
    expect(new Set(AI_EDIT_PROMPT_PRESETS.map((preset) => preset.prompt)).size).toBe(4);
    for (const preset of AI_EDIT_PROMPT_PRESETS) {
      expect(preset.label.trim()).not.toBe('');
      expect(validateAiEditPrompt(preset.prompt)).toBe(preset.prompt);
    }
  });

  it('trims outer whitespace while preserving the internal wording and line breaks', () => {
    expect(validateAiEditPrompt(' \n Keep the problem.\nKeep its outcome. \t')).toBe(
      'Keep the problem.\nKeep its outcome.',
    );
    expect(() => validateAiEditPrompt(' \n\t\u2003')).toThrow('Enter instructions');
  });

  it('enforces the same UTF-16 limit as Swift, including non-BMP characters', () => {
    expect(validateAiEditPrompt('x'.repeat(MAX_AI_EDIT_PROMPT_LENGTH))).toHaveLength(2000);
    expect(validateAiEditPrompt('😀'.repeat(1000))).toHaveLength(2000);
    expect(() => validateAiEditPrompt('😀'.repeat(1001))).toThrow('2,000');
    expect(() => validateAiEditPrompt('x'.repeat(MAX_AI_EDIT_PROMPT_LENGTH + 1))).toThrow('2,000');
  });
});
