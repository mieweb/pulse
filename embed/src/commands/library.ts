import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { deleteDraft, renameDraft, setDraftContext } from '@/db/drafts';
import { libraryNewerSchema } from '@/db/host-context';
import { dismissReceipt, getReceipt } from '@/db/receipts';
import { drafts } from '@/db/schema';
import { getUploadJob } from '@/db/upload-jobs';
import { uploadRulesOf } from '@/features/export/send-checks';
import { mergeForSend } from '@/features/export/send-merge';
import { cancelJob, sendDraft } from '@/features/upload/core/outbox';
import { retireSentFile } from '@/features/upload/core/retire';
import type { JobRunner } from '@/features/upload/core/runner';

import { CommandError, type CommandDeps } from './router';

/** What the commands need from the runtime that isn't the library itself. */
export type LibraryDepsInput = {
  runner: () => JobRunner | null;
  heldDraft: () => string | null;
  uploadMode: () => 'pulse' | 'file';
  changed: (ids: readonly string[]) => Promise<void>;
};

/** The draft's upload type's size cap (O15), checked once the send files are written. */
function maxBytesOf(draftId: string): number | null {
  const row = db
    .select({ uploadTypeJson: drafts.uploadTypeJson })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .get();
  if (!row?.uploadTypeJson) return null;
  try {
    return uploadRulesOf(JSON.parse(row.uploadTypeJson))?.maxBytes ?? null;
  } catch {
    return null;
  }
}

/** The commands' deps over the runtime's library, outbox and job loop. */
export function libraryDeps(input: LibraryDepsInput): CommandDeps {
  return {
    draft(id) {
      const row = db
        .select({ hostConfirmedAt: drafts.hostConfirmedAt })
        .from(drafts)
        .where(eq(drafts.id, id))
        .get();
      if (!row) return null;
      return { jobState: getUploadJob(id)?.state ?? null, clockBound: row.hostConfirmedAt != null };
    },
    hasReceipt: (id) => getReceipt(id) != null,
    newerSchema: libraryNewerSchema,
    heldDraft: input.heldDraft,
    uploadMode: input.uploadMode,
    cancelJob,
    rename: renameDraft,
    remove: deleteDraft,
    setContext: (id, context) => setDraftContext(id, context),
    async send(id) {
      const maxBytes = maxBytesOf(id);
      const { clientKey, draftKey, sentAt } = await sendDraft(id, () => mergeForSend(id), {
        beforeConfirm: ({ bytesTotal }) => {
          if (maxBytes != null && bytesTotal > maxBytes) {
            throw new CommandError(
              'upload.too_large',
              `Draft ${id} is ${bytesTotal} bytes, over its upload type's ${maxBytes}.`,
              { draftId: id },
            );
          }
        },
      });
      return { clientKey, draftKey, sentAt };
    },
    retireFile: (id) => retireSentFile(id),
    recheck(id) {
      const runner = input.runner();
      if (runner && getUploadJob(id)?.state === 'delivering') void runner.runJob(id);
    },
    dismissReceipt: (id) => dismissReceipt(id, Date.now()),
    async resumeOutbox() {
      await input.runner()?.resumeOutbox();
    },
    changed: input.changed,
  };
}
