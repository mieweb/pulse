import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { requireOptionalNativeModule } from 'expo';

import aiEditor, { type AiEditorPassage, type AiEditorSelection } from './AiEditorModule';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
jest.mock('expo', () => {
  const native = { availability: jest.fn(), selectPassages: jest.fn(), cancel: jest.fn() };
  return { requireOptionalNativeModule: () => native };
});

const native = requireOptionalNativeModule<{
  selectPassages: jest.Mock<
    (passages: AiEditorPassage[], targetMs: number, id: string) => Promise<AiEditorSelection>
  >;
  cancel: jest.Mock<(id: string) => Promise<void>>;
}>('AiEditor')!;
const passages = [{ id: 'p1', text: 'Keep this thought.', durationMs: 1_000 }];

beforeEach(() => {
  native.selectPassages.mockReset();
  native.cancel.mockReset().mockResolvedValue(undefined);
});

describe('native request cancellation', () => {
  it('carries early cancellation across the bridge and waits for selection to observe it', async () => {
    const cancelled = new Set<string>();
    let registerSelection!: () => void;
    native.selectPassages.mockImplementation(
      (_passages, _targetMs, id) =>
        new Promise((resolve, reject) => {
          registerSelection = () => {
            if (cancelled.has(id)) {
              reject(Object.assign(new Error('Cancelled'), { code: 'ERR_AI_CANCELLED' }));
            } else {
              resolve({ selectedIds: ['p1'] });
            }
          };
        }),
    );
    native.cancel.mockImplementation(async (id) => {
      cancelled.add(id);
    });

    const selection = aiEditor.selectPassages(passages, 2_000);
    const outcome = selection.catch((error: unknown) => error);
    const cancellation = aiEditor.cancel();
    let cancelSettled = false;
    void cancellation.then(() => {
      cancelSettled = true;
    });

    // Cancellation crosses first; the native select Task has not registered yet.
    expect(native.selectPassages).not.toHaveBeenCalled();
    expect(native.cancel).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(native.cancel.mock.calls[0][0]).toBe(native.selectPassages.mock.calls[0][2]);
    expect(cancelSettled).toBe(false);
    registerSelection();

    await expect(outcome).resolves.toMatchObject({ code: 'ERR_AI_CANCELLED' });
    await cancellation;
    native.selectPassages.mockResolvedValue({ selectedIds: ['p1'] });
    await expect(aiEditor.selectPassages(passages, 2_000)).resolves.toEqual({ selectedIds: ['p1'] });
    expect(native.selectPassages.mock.calls[1][2]).not.toBe(native.selectPassages.mock.calls[0][2]);
  });

  it('rejects overlap without replacing the request cancellation targets', async () => {
    let settle!: (result: AiEditorSelection) => void;
    native.selectPassages.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const selection = aiEditor.selectPassages(passages, 2_000);
    await expect(aiEditor.selectPassages(passages, 2_000)).rejects.toMatchObject({
      code: 'ERR_AI_BUSY',
    });
    const cancellation = aiEditor.cancel();
    expect(native.cancel.mock.calls[0][0]).toBe(native.selectPassages.mock.calls[0][2]);
    settle({ selectedIds: ['p1'] });
    await selection;
    await cancellation;
    expect(native.selectPassages).toHaveBeenCalledTimes(1);
  });
});
