import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import migrations from '../../../drizzle/migrations';
import { exportSignature, type ExportAudio } from '@/core/media/merge-signature';
import { env } from '@/test-support/expo-fs-node';

jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));
jest.mock(
  'expo-sqlite',
  () =>
    jest.requireActual<typeof import('@/test-support/expo-sqlite-node')>(
      '@/test-support/expo-sqlite-node',
    ).mockModule,
);
jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
// An edit renders its cover first: here it is an empty file where the cover goes.
jest.mock('@/utils/video', () => {
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  return {
    generateThumbnailFile: async (_src: string, dest: string) => {
      const file = decodeURIComponent(dest.replace(/^file:\/\//, ''));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '');
      return true;
    },
    coverFailed: () => {},
    markCoverInFlight: () => {},
  };
});
jest.mock('@/db/secure-token', () => ({ deleteSavedLink: async () => {} }));
jest.mock('expo-crypto', () => ({
  randomUUID: () => jest.requireActual<typeof import('node:crypto')>('node:crypto').randomUUID(),
}));

// One "device": the library as the app opens it (`@/db/client` opens it on import), migrated.
const ROOT = mkdtempSync(join(tmpdir(), 'pulse-catalog-'));
const DOCS = join(ROOT, 'Documents');
const AUDIO: ExportAudio = { sampleRate: 48000, channels: 1 };
const INSTALL = 'inst-1';
const DAY = 24 * 60 * 60 * 1000;

let lib!: {
  client: typeof import('@/db/client');
  drafts: typeof import('@/db/drafts');
  schema: typeof import('@/db/schema');
  queries: typeof import('@/db/catalog-queries');
  catalog: typeof import('./catalog');
};

beforeAll(async () => {
  Object.assign(env, { docDir: DOCS, cacheDir: join(ROOT, 'Caches'), dbDir: join(DOCS, 'SQLite') });
  for (const dir of [env.docDir, env.cacheDir, env.dbDir]) mkdirSync(dir, { recursive: true });
  lib = {
    client: jest.requireActual('@/db/client'),
    drafts: jest.requireActual('@/db/drafts'),
    schema: jest.requireActual('@/db/schema'),
    queries: jest.requireActual('@/db/catalog-queries'),
    catalog: jest.requireActual('./catalog'),
  };
  await migrate(lib.client.db, migrations);
});
afterAll(() => {
  lib?.client.expoDb.closeSync();
  rmSync(ROOT, { recursive: true, force: true });
});

const exportFile = (draftId: string) => join(DOCS, 'drafts', draftId, 'export.mp4');

/** The catalog as the writer projects it (minus the writer's own reads: the model, the format). */
function project(now = Date.now(), captionModel: string | null = null) {
  const rows = lib.queries.readCatalogRows(now, captionModel);
  const exportBytes = new Map<string, number>();
  for (const d of rows.drafts) {
    if (existsSync(exportFile(d.id))) exportBytes.set(d.id, statSync(exportFile(d.id)).size);
  }
  return lib.catalog.projectCatalog(
    { rows, installationId: INSTALL, audio: AUDIO, root: DOCS, exportBytes, captionModel },
    now,
  );
}

/** The catalog shows the drafts Home shows, with Home's clip counts, durations and covers. */
async function expectSameAsHome(catalog: ReturnType<typeof project>) {
  const home = await lib.drafts.draftListQuery;
  const byId = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  expect(
    byId(
      catalog.drafts.map((d) => ({
        id: d.id,
        clipCount: d.clipCount,
        durationMs: d.durationMs,
        cover: d.poster?.rel ?? null,
      })),
    ),
  ).toEqual(
    byId(
      home.map((r) => ({
        id: r.id,
        clipCount: r.segmentCount,
        durationMs: r.durationMs,
        cover: r.firstSegmentThumbnail,
      })),
    ),
  );
}

const draftIn = (catalog: ReturnType<typeof project>, id: string) =>
  catalog.drafts.find((d) => d.id === id);

describe('projectCatalog', () => {
  const ticket = {
    key: 'ticket:t-1',
    kind: 'ticket',
    id: 'T-1',
    label: 'Fix login',
    data: { type: 'ticket.video', target: { ticketId: 'T-1' } },
  };
  const uploadType = { id: 'ticket.video', version: 1, title: 'Ticket' };
  let host = '';
  let app = '';

  it('create: a host draft with its place and an app draft without one', async () => {
    host = await lib.drafts.createDraft({ hostContext: ticket, uploadType, createdVia: 'host' });
    app = await lib.drafts.createDraft({ name: 'Walkthrough' });
    const catalog = project();
    await expectSameAsHome(catalog);
    expect(draftIn(catalog, host)).toMatchObject({
      draftKey: `${INSTALL}:${host}`,
      name: 'Fix login', // unnamed: called by its place
      context: { ...ticket, uploadType },
      state: 'draft',
      clipCount: 0,
      durationMs: 0,
      hasCaptions: false,
      poster: null,
      createdVia: 'host',
    });
    expect(draftIn(catalog, host)).not.toHaveProperty('export');
    expect(draftIn(catalog, host)).not.toHaveProperty('upload');
    expect(draftIn(catalog, app)).toMatchObject({
      name: 'Walkthrough',
      context: null,
      createdVia: 'app',
    });
  });

  it('add clip: the count, duration and the first clip’s cover as poster', async () => {
    for (const [id, durationMs] of [
      ['s1', 3000],
      ['s2', 1500],
    ] as const) {
      await lib.drafts.addSegment(host, {
        id,
        originalFilename: `drafts/${host}/segments/${id}.mp4`,
        durationMs,
        thumbnail: `drafts/${host}/segments/${id}.thumb.jpg`,
      });
    }
    const catalog = project();
    await expectSameAsHome(catalog);
    expect(draftIn(catalog, host)).toMatchObject({
      clipCount: 2,
      durationMs: 4500,
      poster: {
        rel: `drafts/${host}/segments/s1.thumb.jpg`,
        path: `${DOCS}/drafts/${host}/segments/s1.thumb.jpg`,
        webUrl: '',
      },
    });
  });

  it('ready: the export on disk is of exactly these clips', async () => {
    const clips = await lib.drafts.segmentsForDraft(host);
    mkdirSync(dirname(exportFile(host)), { recursive: true });
    writeFileSync(exportFile(host), Buffer.alloc(1234));
    await lib.drafts.setMergedExport(host, {
      signature: exportSignature(clips, AUDIO),
      durationMs: 4500,
    });
    const catalog = project();
    expect(draftIn(catalog, host)).toMatchObject({
      state: 'ready',
      bytes: 1234,
      export: {
        rel: `drafts/${host}/export.mp4`,
        path: `${DOCS}/drafts/${host}/export.mp4`,
        webUrl: '',
        bytes: 1234,
      },
    });
    // Merged in another audio layout, it isn't this device's export.
    const other = lib.catalog.projectCatalog(
      {
        rows: lib.queries.readCatalogRows(Date.now(), null),
        installationId: INSTALL,
        audio: { sampleRate: 44100, channels: 2 },
        root: DOCS,
        exportBytes: new Map([[host, 1234]]),
        captionModel: null,
      },
      Date.now(),
    );
    expect(draftIn(other, host)?.state).toBe('draft');
  });

  it('edit: a trim changes the duration Home shows, and the export is no longer current', async () => {
    await lib.drafts.setClipEdit('s2', {
      startMs: 0,
      endMs: 1000,
      rotation: 0,
      flipped: false,
      crop: null,
      muted: false,
      speed: 1,
    });
    const catalog = project();
    await expectSameAsHome(catalog);
    const draft = draftIn(catalog, host);
    expect(draft).toMatchObject({ state: 'draft', clipCount: 2, durationMs: 4000 });
    expect(draft).not.toHaveProperty('export');
    expect(draft).not.toHaveProperty('bytes');
  });

  it('rename: the draft’s own name wins over its place', async () => {
    await lib.drafts.renameDraft(host, 'Login fix, take 2');
    const catalog = project();
    await expectSameAsHome(catalog);
    expect(draftIn(catalog, host)?.name).toBe('Login fix, take 2');
  });

  it('job insert and state changes: the job’s state, keys, progress and error', async () => {
    const { db } = lib.client;
    const { uploadJobs } = lib.schema;
    db.insert(uploadJobs)
      .values({
        draftId: host,
        state: 'queued',
        clientKey: `${INSTALL}:${host}:0123456789abcdef`,
        draftKey: `${INSTALL}:${host}`,
        mergedSignature: 'sig',
        sentAt: 500,
      })
      .run();
    let catalog = project();
    await expectSameAsHome(catalog);
    expect(draftIn(catalog, host)).toMatchObject({
      state: 'queued',
      draftKey: `${INSTALL}:${host}`,
      upload: { clientKey: `${INSTALL}:${host}:0123456789abcdef`, attempts: 0, sentAt: 500 },
    });
    expect(draftIn(catalog, host)?.upload).not.toHaveProperty('progress');

    // Started, no byte sent yet: still no progress (absent before the first byte).
    db.update(uploadJobs)
      .set({ state: 'uploading', bytesTotal: 200, bytesSent: 0 })
      .where(eq(uploadJobs.draftId, host))
      .run();
    expect(draftIn(project(), host)?.upload).not.toHaveProperty('progress');

    const later = Date.now() + 60_000;
    db.update(uploadJobs)
      .set({
        state: 'uploading',
        uploadId: 'u-1',
        artifactId: 'a-1',
        bytesTotal: 200,
        bytesSent: 50,
        attempts: 1,
        updatedAt: later,
      })
      .where(eq(uploadJobs.draftId, host))
      .run();
    catalog = project();
    expect(draftIn(catalog, host)).toMatchObject({
      state: 'uploading',
      updatedAt: later, // the job changed after the draft did
      upload: { uploadId: 'u-1', artifactId: 'a-1', progress: 0.25, attempts: 1 },
    });
    expect(catalog.drafts[0].id).toBe(host); // newest change first

    db.update(uploadJobs)
      .set({ state: 'needs_credentials', lastErrorCode: 'host.unavailable' })
      .where(eq(uploadJobs.draftId, host))
      .run();
    expect(draftIn(project(), host)).toMatchObject({
      state: 'needs_credentials',
      upload: { error: { code: 'host.unavailable', message: '', recoverable: true, callId: '' } },
    });

    db.update(uploadJobs)
      .set({ state: 'failed', lastErrorCode: 'destination.gone', lastErrorMessage: 'Gone' })
      .where(eq(uploadJobs.draftId, host))
      .run();
    catalog = project();
    await expectSameAsHome(catalog);
    expect(draftIn(catalog, host)).toMatchObject({
      state: 'failed',
      upload: { error: { code: 'destination.gone', message: 'Gone', recoverable: false } },
    });
  });

  it('delete: the draft leaves the catalog as it leaves Home', async () => {
    await lib.drafts.deleteDraft(app);
    const catalog = project();
    await expectSameAsHome(catalog);
    expect(draftIn(catalog, app)).toBeUndefined();
  });

  const delivered = Date.now();

  it('retire: the draft becomes a receipt, sent, with its place and outcome', async () => {
    const { db } = lib.client;
    const { drafts, uploadReceipts } = lib.schema;
    // pulse-schema.md §4.3: the receipt and the draft's deletion in one transaction.
    db.transaction((tx) => {
      tx.insert(uploadReceipts)
        .values({
          draftId: host,
          name: 'Login fix, take 2',
          contextKey: 'ticket:t-1',
          contextLabel: 'Fix login',
          contextJson: JSON.stringify({ kind: 'ticket', id: 'T-1', label: 'Fix login' }),
          uploadTypeJson: JSON.stringify(uploadType),
          outcome: 'kept',
          reason: 'The ticket was closed',
          uploadId: 'u-1',
          artifactId: 'a-1',
          clientKey: `${INSTALL}:${host}:0123456789abcdef`,
          clipCount: 2,
          durationMs: 4000,
          sentAt: 500,
          deliveredAt: delivered,
          expiresAt: delivered + 7 * DAY,
        })
        .run();
      tx.delete(drafts).where(eq(drafts.id, host)).run();
    });
    const catalog = project();
    await expectSameAsHome(catalog);
    expect(catalog.drafts).toEqual([]);
    expect(catalog.receipts).toEqual([
      {
        id: host,
        draftKey: `${INSTALL}:${host}`,
        name: 'Login fix, take 2',
        context: {
          key: 'ticket:t-1',
          kind: 'ticket',
          id: 'T-1',
          label: 'Fix login',
          uploadType,
        },
        state: 'sent',
        clipCount: 2,
        durationMs: 4000,
        hasCaptions: false,
        poster: null,
        sent: {
          outcome: 'kept',
          reason: 'The ticket was closed',
          uploadId: 'u-1',
          artifactId: 'a-1',
          sentAt: 500,
          at: delivered,
          expiresAt: delivered + 7 * DAY,
          dismissed: false,
        },
        createdVia: 'host',
        createdAt: 500,
        updatedAt: delivered,
      },
    ]);
  });

  it('receipt expiry: a receipt past its 7 days is left out', () => {
    expect(project(delivered + 7 * DAY).receipts.map((r) => r.id)).toEqual([host]);
    expect(project(delivered + 7 * DAY + 1).receipts).toEqual([]);
  });
});

describe('hasCaptions', () => {
  it('follows what an upload would send: edited captions, and every speaking clip transcribed', async () => {
    const { db } = lib.client;
    const { segments, clipTranscripts } = lib.schema;
    const id = await lib.drafts.createDraft({ name: 'Captions' });
    for (const s of ['c1', 'c2']) {
      await lib.drafts.addSegment(id, {
        id: s,
        originalFilename: `drafts/${id}/segments/${s}.mp4`,
        durationMs: 2000,
        thumbnail: null,
      });
    }
    const has = (model: string | null) =>
      draftIn(project(Date.now(), model), id)?.hasCaptions ?? null;
    expect(has(null)).toBe(false);

    // The person edited the first clip's captions.
    db.update(segments)
      .set({
        captionEdit: JSON.stringify({
          file: `drafts/${id}/segments/c1.mp4`,
          words: [{ text: 'Hello', t0: 10, t1: 50 }],
        }),
      })
      .where(eq(segments.id, 'c1'))
      .run();
    expect(has(null)).toBe(true); // no model: the edited captions are all there is
    expect(has('model-a')).toBe(false); // the second clip isn't transcribed yet: none go up

    db.insert(clipTranscripts)
      .values({
        segmentId: 'c2',
        model: 'model-a',
        file: `drafts/${id}/segments/c2.mp4`,
        status: 'done',
        words: JSON.stringify([]),
      })
      .run();
    expect(has('model-a')).toBe(true);
    expect(has('model-b')).toBe(false); // another model's transcripts don't count
  });
});
