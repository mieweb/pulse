import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('@/db/settings', () => ({ getSetting: jest.fn(), setSetting: jest.fn() }));

/* eslint-disable import/first -- mock storage before importing the preferences */
import { getSetting, setSetting } from '@/db/settings';
import {
  DEFAULT_AI_EDIT_PROMPT,
  MAX_AI_EDIT_PROMPT_LENGTH,
} from '../../../modules/expo-ai-editor/src/prompt';
import { loadAiEditPrompt, saveAiEditPrompt } from './preferences';
/* eslint-enable import/first */

beforeEach(() => {
  jest.resetAllMocks();
});

describe('local AI editing instructions', () => {
  it('uses the known default on an existing install with no preference', async () => {
    jest.mocked(getSetting).mockResolvedValue(null);
    await expect(loadAiEditPrompt()).resolves.toBe(DEFAULT_AI_EDIT_PROMPT);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('round-trips custom instructions without changing their content', async () => {
    const prompt = 'Keep decisions and next steps.\nPreserve the speaker’s qualifications.';
    jest.mocked(setSetting).mockResolvedValue();
    await saveAiEditPrompt(`  ${prompt}  `);
    expect(setSetting).toHaveBeenCalledWith('ai-edit.prompt', prompt);
    jest.mocked(getSetting).mockResolvedValue(prompt);
    await expect(loadAiEditPrompt()).resolves.toBe(prompt);
  });

  it('recovers invalid restored preferences without writing or accepting them', async () => {
    for (const invalid of ['', '   ', 'x'.repeat(MAX_AI_EDIT_PROMPT_LENGTH + 1)]) {
      jest.mocked(getSetting).mockResolvedValue(invalid);
      await expect(loadAiEditPrompt()).resolves.toBe(DEFAULT_AI_EDIT_PROMPT);
      await expect(saveAiEditPrompt(invalid)).rejects.toThrow();
    }
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('surfaces actual storage failures so the UI can report them', async () => {
    jest.mocked(getSetting).mockRejectedValue(new Error('Storage unavailable'));
    await expect(loadAiEditPrompt()).rejects.toThrow('Storage unavailable');
    jest.mocked(setSetting).mockRejectedValue(new Error('Storage full'));
    await expect(saveAiEditPrompt(DEFAULT_AI_EDIT_PROMPT)).rejects.toThrow('Storage full');
  });
});
