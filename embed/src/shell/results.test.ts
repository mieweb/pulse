import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { OpenRequest, PulseContext, PulseErrorInfo } from '@mieweb/pulse-embed';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { env, File as FsFile } from '@/test-support/expo-fs-node';

import { flowReducer, initFlow, type FlowEvent, type FlowState } from '../flow/reducer';
import { flowResult } from '../flow/result';
import { saveExportForHost, startupFailure, writeFlowResult, writeResultFile } from './results';

jest.mock('expo-file-system', () => jest.requireActual('@/test-support/expo-fs-node'));

const context: PulseContext = {
  key: 'ticket:t-42',
  kind: 'ticket',
  id: 'T-42',
  label: 'Fix login',
};
const record: OpenRequest = { entry: 'record', context };
const failure: PulseErrorInfo = {
  code: 'permission.camera',
  message: 'Camera access was denied.',
  recoverable: false,
  callId: '',
};

let docs = '';
const results = () => join(docs, 'results');
const read = (name: string) => JSON.parse(readFileSync(join(results(), name), 'utf8'));

const realMove = FsFile.prototype.moveSync;

beforeEach(() => {
  // A fresh "device": the library's documents root is this folder (storage-root's default).
  docs = mkdtempSync(join(tmpdir(), 'pulse-results-'));
  env.docDir = docs;
  // The move as expo-file-system 57 does it natively: with `overwrite` it deletes the destination,
  // then moves (not one atomic rename, as the stand-in's renameSync would be); without, an
  // existing destination is an error.
  jest.spyOn(FsFile.prototype, 'moveSync').mockImplementation(function (
    this: FsFile,
    ...args: unknown[]
  ) {
    const [dest, opts] = args as [FsFile, { overwrite?: boolean } | undefined];
    if (dest.exists) {
      if (!opts?.overwrite) throw new Error('destination exists');
      dest.delete();
    }
    realMove.call(this, dest);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  rmSync(docs, { recursive: true, force: true });
});

function run(state: FlowState, ...events: FlowEvent[]): FlowState {
  return events.reduce(flowReducer, state);
}

describe('writeResultFile', () => {
  it('writes results/<name> with no .part left behind', () => {
    writeResultFile('r1.json', '{"a":1}');
    expect(read('r1.json')).toEqual({ a: 1 });
    expect(readdirSync(results())).toEqual(['r1.json']);
  });

  it('replaces an earlier file and a .part a crash left', () => {
    writeResultFile('r1.json', '{"a":1}');
    writeFileSync(join(results(), 'r1.json.part'), '{"half');
    writeResultFile('r1.json', '{"a":2}');
    expect(read('r1.json')).toEqual({ a: 2 });
    expect(readdirSync(results())).toEqual(['r1.json']);
  });

  it('replaces an earlier file with the native delete-then-move', () => {
    writeResultFile('r1.json', '{"a":1}');
    writeResultFile('r1.json', '{"a":2}');
    // Both writes went through the native-like move, the second over the first.
    expect(FsFile.prototype.moveSync).toHaveBeenCalledTimes(2);
    expect(read('r1.json')).toEqual({ a: 2 });
    expect(readdirSync(results())).toEqual(['r1.json']);
  });

  it('leaves the old file whole when the move fails before it deletes anything', () => {
    writeResultFile('r1.json', '{"a":1}');
    jest.spyOn(FsFile.prototype, 'moveSync').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => writeResultFile('r1.json', '{"a":2}')).toThrow('disk full');
    // The reader never sees a half-written result: the old one, and no .part.
    expect(read('r1.json')).toEqual({ a: 1 });
    expect(readdirSync(results())).toEqual(['r1.json']);
  });
});

describe('writeFlowResult', () => {
  it('writes the FlowResult as results/<requestId>.json and points at it', () => {
    const state = run(
      initFlow('req-1', record),
      { type: 'mounted' },
      { type: 'record' },
      { type: 'stop', draftId: 'd1', clipCount: 1 },
      { type: 'close' },
      { type: 'keep' },
    );
    const result = flowResult(state, 1_700_000_000_000.4);
    if (!result) throw new Error('the flow should have ended');
    const ref = writeFlowResult(result);
    expect(ref).toMatchObject({ rel: 'results/req-1.json', path: join(results(), 'req-1.json') });
    expect(read('req-1.json')).toEqual({
      requestId: 'req-1',
      entry: 'record',
      endedOn: 'recorder',
      stage: 'recorded',
      context,
      endedAt: 1_700_000_000_000,
      status: 'closed',
      reason: 'user',
      draftId: 'd1',
    });
  });
});

describe('failed results', () => {
  it('a flow that failed keeps the draft with a clip and drops undefined fields', () => {
    const state = run(
      initFlow('req-2', record),
      { type: 'mounted' },
      { type: 'record' },
      { type: 'stop', draftId: 'd2', clipCount: 2 },
      { type: 'error', error: { ...failure, draftId: undefined } },
    );
    writeFlowResult(flowResult(state, 5)!);
    const json = read('req-2.json');
    expect(json).toEqual({
      requestId: 'req-2',
      entry: 'record',
      endedOn: 'recorder',
      stage: 'recorded',
      context,
      endedAt: 5,
      status: 'failed',
      error: failure,
      draftId: 'd2',
    });
    expect('draftId' in json.error).toBe(false);
  });

  it('a request refused before any screen ends on no screen, with no draft', () => {
    const error: PulseErrorInfo = {
      code: 'not_found',
      message: 'Pulse has no draft d9.',
      recoverable: false,
      callId: '',
      requestId: 'req-3',
      draftId: undefined,
    };
    const result = startupFailure({ requestId: 'req-3', entry: 'edit', error, endedAt: 7.6 });
    writeFlowResult(result);
    expect(read('req-3.json')).toEqual({
      requestId: 'req-3',
      entry: 'edit',
      endedOn: null,
      stage: 'none',
      context: null,
      endedAt: 8,
      status: 'failed',
      error: {
        code: 'not_found',
        message: 'Pulse has no draft d9.',
        recoverable: false,
        callId: '',
        requestId: 'req-3',
      },
    });
  });
});

describe('saveExportForHost (file mode)', () => {
  it('copies the export and writes the project document next to the result', async () => {
    const exportPath = join(docs, 'drafts', 'd1', 'export.mp4');
    mkdirSync(join(docs, 'drafts', 'd1'), { recursive: true });
    writeFileSync(exportPath, 'mp4-bytes');
    const project = { format: 'pulse-project', version: 2, tables: {} };

    const files = await saveExportForHost({
      requestId: 'req-4',
      exportPath,
      project: () => project,
    });

    expect(files.export).toEqual({
      rel: 'results/req-4.mp4',
      path: join(results(), 'req-4.mp4'),
      webUrl: '',
      bytes: 'mp4-bytes'.length,
    });
    expect(files.project).toMatchObject({
      rel: 'results/req-4.project.json',
      path: join(results(), 'req-4.project.json'),
      webUrl: '',
    });
    expect(readFileSync(files.export.path, 'utf8')).toBe('mp4-bytes');
    expect(read('req-4.project.json')).toEqual(project);
    // The draft's own export stays where it was: the host gets a copy it owns.
    expect(existsSync(exportPath)).toBe(true);
    expect(readdirSync(results()).sort()).toEqual(['req-4.mp4', 'req-4.project.json']);
  });

  it('takes a file URI as well as a path', async () => {
    const exportPath = join(docs, 'export.mp4');
    writeFileSync(exportPath, 'x');
    const files = await saveExportForHost({
      requestId: 'req-5',
      exportPath: `file://${exportPath}`,
      project: () => ({}),
    });
    expect(readFileSync(files.export.path, 'utf8')).toBe('x');
  });

  it('leaves no partial copy when the export is missing', async () => {
    await expect(
      saveExportForHost({
        requestId: 'req-6',
        exportPath: join(docs, 'missing.mp4'),
        project: () => ({}),
      }),
    ).rejects.toThrow();
    expect(readdirSync(results())).toEqual([]);
  });
});
