import { asc, desc, eq } from 'drizzle-orm';
import * as Crypto from 'expo-crypto';

import {
  absolutize,
  deleteQuietly,
  persistVoiceoverRecording,
  toFileUri,
} from '@/utils/file-store';
import { db } from './client';
import { beginDraftMutation, dropHistoryFiles } from './drafts';
import { assertEditable, LibraryError } from './host-context';
import { drafts, voiceoverTakes, type VoiceoverTake } from './schema';

export function voiceoverTakesQuery(draftId: string) {
  return db
    .select()
    .from(voiceoverTakes)
    .where(eq(voiceoverTakes.draftId, draftId))
    .orderBy(asc(voiceoverTakes.sequence));
}

export function voiceoverSettingsQuery(draftId: string) {
  return db
    .select({ sourceAudioMuted: drafts.sourceAudioMuted, voiceoverMuted: drafts.voiceoverMuted })
    .from(drafts)
    .where(eq(drafts.id, draftId));
}

export type VoiceoverState = {
  takes: VoiceoverTake[];
  sourceMuted: boolean;
  voiceoverMuted: boolean;
};

/** The saved mix; temporary monitoring silence while recording never changes this state. */
export async function getVoiceover(draftId: string): Promise<VoiceoverState> {
  const draft = db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  return {
    takes: voiceoverTakesQuery(draftId).all(),
    sourceMuted: draft?.sourceAudioMuted ?? false,
    voiceoverMuted: draft?.voiceoverMuted ?? false,
  };
}

export type NewVoiceoverTake = {
  draftId: string;
  cacheUri: string;
  startMs: number;
  recordStartMs: number;
  durationMs: number;
  trimStartMs?: number;
  trimEndMs?: number;
};

/** Save one immutable source and one take. Failed storage leaves every earlier take intact. */
export async function addVoiceoverTake(input: NewVoiceoverTake): Promise<VoiceoverTake> {
  const { draftId, cacheUri, startMs, recordStartMs, durationMs } = input;
  const trimStartMs = input.trimStartMs ?? 0;
  const trimEndMs = input.trimEndMs ?? durationMs;
  if (
    ![startMs, recordStartMs, durationMs, trimStartMs, trimEndMs].every(Number.isFinite) ||
    startMs < 0 ||
    recordStartMs < 0 ||
    durationMs <= 0 ||
    trimStartMs < 0 ||
    trimEndMs > durationMs ||
    trimEndMs <= trimStartMs
  ) {
    throw new LibraryError('invalid_options', 'The narration timing is invalid.');
  }
  await beginDraftMutation(draftId);
  const id = Crypto.randomUUID();
  let filename: string | undefined;
  try {
    filename = await persistVoiceoverRecording(cacheUri, draftId, id);
    // A Send or delete may have occurred while the media moved. Recheck before inserting.
    await beginDraftMutation(draftId);
    const saved = db.transaction((tx) => {
      if (!tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, draftId)).get()) {
        throw new LibraryError('not_found', 'The draft no longer exists.');
      }
      const previous = tx
        .select({ sequence: voiceoverTakes.sequence })
        .from(voiceoverTakes)
        .where(eq(voiceoverTakes.draftId, draftId))
        .orderBy(desc(voiceoverTakes.sequence))
        .get();
      const take: VoiceoverTake = {
        id,
        draftId,
        filename: filename!,
        startMs,
        recordStartMs,
        durationMs,
        trimStartMs,
        trimEndMs,
        sequence: (previous?.sequence ?? 0) + 1,
        createdAt: Date.now(),
      };
      tx.insert(voiceoverTakes).values(take).run();
      tx.update(drafts).set({ lastModified: Date.now() }).where(eq(drafts.id, draftId)).run();
      return take;
    });
    deleteQuietly(toFileUri(cacheUri));
    return saved;
  } catch (error) {
    if (filename) deleteQuietly(absolutize(filename));
    throw error;
  }
}

/** Restore the removed take's recording position; legacy takes know only their audio start. */
export function voiceoverUndoPosition(
  removed: Pick<VoiceoverTake, 'startMs' | 'recordStartMs'>,
): number {
  return removed.recordStartMs ?? removed.startMs;
}

/** Remove one whole take, newest addition first, without mutating video or preceding takes. */
export async function undoVoiceoverTake(
  draftId: string,
): Promise<{ removed: VoiceoverTake; playheadMs: number } | null> {
  await beginDraftMutation(draftId);
  const result = db.transaction((tx) => {
    const takes = tx
      .select()
      .from(voiceoverTakes)
      .where(eq(voiceoverTakes.draftId, draftId))
      .orderBy(asc(voiceoverTakes.sequence))
      .all();
    const removed = takes.pop();
    if (!removed) return null;
    tx.delete(voiceoverTakes).where(eq(voiceoverTakes.id, removed.id)).run();
    tx.update(drafts).set({ lastModified: Date.now() }).where(eq(drafts.id, draftId)).run();
    return { removed, playheadMs: voiceoverUndoPosition(removed) };
  });
  if (result) await dropHistoryFiles([result.removed.filename]);
  return result;
}

export async function setAudioTrackMuted(
  draftId: string,
  track: 'source' | 'voiceover',
  muted: boolean,
): Promise<void> {
  assertEditable();
  const column = track === 'source' ? 'sourceAudioMuted' : 'voiceoverMuted';
  const current = db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  if (!current) throw new LibraryError('not_found', 'The draft no longer exists.');
  if (current[column] === muted) return;
  await beginDraftMutation(draftId);
  db.update(drafts)
    .set({ [column]: muted, lastModified: Date.now() })
    .where(eq(drafts.id, draftId))
    .run();
}
