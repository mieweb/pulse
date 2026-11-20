import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type { JobRunner } from '@/features/upload/core/runner';

import { libraryDeps } from './library';
import { CommandError } from './router';

// commands/library.ts: the commands' real deps over the library's own functions. The database
// row a query returns, the job's state and what the outbox does are fakes the test sets.

type MockRow = { hostConfirmedAt?: number | null; uploadTypeJson?: string | null } | undefined;
const mockDb = { row: undefined as MockRow };

jest.mock('@/db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ get: () => mockDb.row }) }) }),
  },
}));
jest.mock('@/db/drafts', () => ({
  deleteDraft: jest.fn(async () => {}),
  renameDraft: jest.fn(async () => {}),
  segmentsForDraft: jest.fn(async () => []),
  setDraftContext: jest.fn(async () => {}),
}));
jest.mock('@/db/host-context', () => ({ libraryNewerSchema: () => false }));
jest.mock('@/db/receipts', () => ({ dismissReceipt: jest.fn(), getReceipt: jest.fn() }));
jest.mock('@/db/upload-jobs', () => ({ getUploadJob: jest.fn() }));
jest.mock('@/features/export/editor-merge', () => ({
  exportAudio: jest.fn(),
  mergeWithEditor: jest.fn(),
}));
jest.mock('@/features/export/merged-export', () => ({ resolveMergedExport: jest.fn() }));
jest.mock('@/features/recorder/recorder-format', () => ({ getRecorderFormat: jest.fn() }));
jest.mock('@/features/upload/core/outbox', () => ({ cancelJob: jest.fn(), sendDraft: jest.fn() }));
jest.mock('@/features/upload/core/retire', () => ({ retireSentFile: jest.fn() }));

const jobs = jest.requireMock<{ getUploadJob: jest.Mock }>('@/db/upload-jobs');
const outbox = jest.requireMock<{ cancelJob: jest.Mock; sendDraft: jest.Mock }>(
  '@/features/upload/core/outbox',
);

function deps(runner: Partial<JobRunner> | null = null) {
  return libraryDeps({
    runner: () => runner as JobRunner | null,
    heldDraft: () => null,
    uploadMode: () => 'pulse',
    changed: async () => {},
  });
}

/** sendDraft as the outbox runs it: the host's confirm sees the send files' size, then the keys. */
function sendsBytes(bytesTotal: number) {
  outbox.sendDraft.mockImplementation((async (
    id: string,
    _merge: unknown,
    options: { beforeConfirm?: (s: { bytesTotal: number }) => void },
  ) => {
    options.beforeConfirm?.({ bytesTotal });
    return { draftId: id, clientKey: 'ck', draftKey: 'dk', sentAt: 5 };
  }) as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.row = undefined;
});

describe('the commands’ library deps (commands/library.ts)', () => {
  it('reads a draft’s lock: none without a row, its job state, clock-bound once confirmed', () => {
    expect(deps().draft('d1')).toBeNull();
    mockDb.row = { hostConfirmedAt: null };
    jobs.getUploadJob.mockReturnValue({ state: 'queued' });
    expect(deps().draft('d1')).toEqual({ jobState: 'queued', clockBound: false });
    mockDb.row = { hostConfirmedAt: 123 };
    jobs.getUploadJob.mockReturnValue(undefined);
    expect(deps().draft('d1')).toEqual({ jobState: null, clockBound: true });
  });

  it('takes a Send out with the outbox’s own cancelJob', () => {
    deps().cancelJob('d1', 'edited');
    expect(outbox.cancelJob).toHaveBeenCalledWith('d1', 'edited');
  });

  it('refuses a Send over its upload type’s maxBytes with upload.too_large, before the confirm', async () => {
    mockDb.row = { uploadTypeJson: JSON.stringify({ id: 'clip', maxBytes: 1000 }) };
    sendsBytes(1001);
    const refused = await deps()
      .send('d1')
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CommandError);
    expect(refused).toMatchObject({ code: 'upload.too_large', draftId: 'd1' });
  });

  it('answers a Send within its cap (or with no cap) with the job’s keys', async () => {
    mockDb.row = { uploadTypeJson: JSON.stringify({ id: 'clip', maxBytes: 1000 }) };
    sendsBytes(1000);
    expect(await deps().send('d1')).toEqual({ clientKey: 'ck', draftKey: 'dk', sentAt: 5 });
    mockDb.row = { uploadTypeJson: null };
    sendsBytes(10 ** 9);
    expect(await deps().send('d1')).toEqual({ clientKey: 'ck', draftKey: 'dk', sentAt: 5 });
  });

  it('a pulse-mode retire asks the status route again only for a delivering job', () => {
    const runJob = jest.fn(async () => {});
    const d = deps({ runJob } as Partial<JobRunner>);
    jobs.getUploadJob.mockReturnValue({ state: 'uploading' });
    d.recheck('d1');
    expect(runJob).not.toHaveBeenCalled();
    jobs.getUploadJob.mockReturnValue({ state: 'delivering' });
    d.recheck('d1');
    expect(runJob).toHaveBeenCalledWith('d1');
    // Before the job loop exists, nothing to ask.
    expect(() => deps(null).recheck('d1')).not.toThrow();
  });

  it('resumeOutbox runs the job loop’s launch rule', async () => {
    const resumeOutbox = jest.fn(async () => {});
    await deps({ resumeOutbox } as Partial<JobRunner>).resumeOutbox();
    expect(resumeOutbox).toHaveBeenCalledTimes(1);
  });
});
