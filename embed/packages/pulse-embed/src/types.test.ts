import { describe, expect, it } from '@jest/globals';

// Imported by package name, as a host does: this goes through the jest moduleNameMapper and the
// tsconfig path alias. tsc proves the shapes below; jest proves the runtime exports.
import {
  CONTRACT,
  type CallErrorCode,
  type CloseOptions,
  type ConfigureOptions,
  type ConfirmSendRequest,
  type DraftSummary,
  type FlowErrorCode,
  type FlowResult,
  type HostRequest,
  type HostResponse,
  type HostServiceError,
  type HostServices,
  type OpenRequest,
  type PulseContext,
  type UploadTypeSpec,
} from '@mieweb/pulse-embed';

const wrapUp: UploadTypeSpec = {
  id: 'clock.wrapup',
  version: 1,
  title: 'Wrap-up',
  sendLabel: 'Clock out & send',
  prompt: 'Say what you finished today',
  requireName: false,
  requireOnline: true,
  confirmSend: true,
  maxBytes: 500 * 1024 * 1024,
};

const context: PulseContext = {
  key: 'clock:65a1b2c3d4e5f60718293a4b',
  kind: 'clock',
  id: '65A1B2C3D4E5F60718293A4B',
  label: 'Mon 9:02 session',
  uploadType: wrapUp,
  data: { type: 'clock.wrapup', target: { kind: 'clock', id: '65a1b2c3d4e5f60718293a4b' } },
};

const draft: DraftSummary = {
  id: 'd1',
  draftKey: 'inst-1:d1',
  name: 'Wrap-up Monday',
  context,
  state: 'ready',
  clipCount: 2,
  durationMs: 42_000,
  bytes: 12_345_678,
  hasCaptions: true,
  confirmedAt: 1_763_400_000_000,
  poster: { rel: 'drafts/d1/poster.jpg', path: '/abs/drafts/d1/poster.jpg', webUrl: 'x://p' },
  export: { rel: 'drafts/d1/export.mp4', path: '/abs/drafts/d1/export.mp4', webUrl: 'x://e' },
  createdVia: 'host',
  createdAt: 1_763_300_000_000,
  updatedAt: 1_763_400_000_000,
};

// @ts-expect-error draftKey is required (PLAN-final §8 / AD32)
const noDraftKey: DraftSummary = { ...draft, draftKey: undefined };
// @ts-expect-error hasCaptions is required (PLAN-final §8 / AD29)
const noCaptionsFlag: DraftSummary = { ...draft, hasCaptions: undefined };

const opens: OpenRequest[] = [
  { entry: 'record', context },
  {
    entry: 'record',
    context,
    draft: { continue: 'd1' },
    requestId: 'r1',
    theme: { accent: '#0a7' },
  },
  { entry: 'edit', draftId: 'd1', clipId: 'c1' },
  { entry: 'export', draftId: 'd1' },
];

const base = { requestId: 'r1', entry: 'record', context, endedAt: 1_763_400_000_000 } as const;

const results: FlowResult[] = [
  {
    ...base,
    status: 'completed',
    mode: 'pulse',
    endedOn: 'export',
    stage: 'exported',
    draftId: 'd1',
    sentAt: 1_763_399_000_000,
    clientKey: 'inst-1:d1:0123456789abcdef',
    draftKey: 'inst-1:d1',
    confirmedAt: 1_763_399_000_500,
    draft,
  },
  {
    ...base,
    status: 'completed',
    mode: 'file',
    endedOn: 'export',
    stage: 'exported',
    draftId: 'd1',
    export: { rel: 'results/r1.mp4', path: '/abs/results/r1.mp4', webUrl: 'x://r' },
    durationMs: 42_000,
  },
  {
    ...base,
    status: 'closed',
    reason: 'host',
    endedOn: 'recorder',
    stage: 'recorded',
    draftId: 'd1',
  },
  { ...base, status: 'canceled', reason: 'user', endedOn: 'recorder', stage: 'none' },
  {
    ...base,
    status: 'failed',
    endedOn: null,
    stage: 'none',
    error: {
      code: 'upload.too_large',
      message: 'over the cap',
      recoverable: false,
      callId: 'c-1',
      reason: 'server_cap',
    },
  },
];

// Exhaustive over FlowResult: a new status or mode that isn't handled fails tsc here.
function describeResult(r: FlowResult): string {
  switch (r.status) {
    case 'completed':
      return r.mode === 'pulse' ? `sent ${r.draftKey}` : `file ${r.export.rel}`;
    case 'closed':
      return `kept ${r.draftId}`;
    case 'canceled':
      return 'discarded';
    case 'failed':
      return `failed ${r.error.code}`;
    default: {
      const never: never = r;
      return never;
    }
  }
}

const confirmed: ConfirmSendRequest[] = [];

const services: HostServices = {
  async getUploadTarget(r) {
    return {
      uploadId: 'u1',
      endpoint: 'https://host/pulsevault',
      artifactId: 'a1',
      token: 't',
      expiresAt: r.sentAt + 1_800_000,
      clientKey: r.clientKey,
    };
  },
  async refreshUploadToken() {
    return { token: 't2', expiresAt: 1 };
  },
  async releaseUploadTarget() {},
  async confirmSend(r) {
    confirmed.push(r);
    return { confirmedAt: r.sentAt + 500 };
  },
};

const confirmArgs: ConfirmSendRequest = {
  draftId: 'd1',
  draftKey: 'inst-1:d1',
  context,
  uploadType: wrapUp,
  sentAt: 10,
  bytes: 99,
};

const request: HostRequest = {
  hostCallId: 'h-1',
  method: 'confirmSend',
  args: confirmArgs,
  deadline: 20_010,
};

// @ts-expect-error a hostRequest's args must match its method
const mismatched: HostRequest = {
  hostCallId: 'h-1',
  method: 'refreshUploadToken',
  args: confirmArgs,
  deadline: 20_010,
};

const tooLarge: HostServiceError = { code: 'upload.too_large', message: 'over 500 MB' };
const replies: HostResponse[] = [
  { hostCallId: 'h-1', result: { confirmedAt: 510 } },
  { hostCallId: 'h-2', error: tooLarge },
  // releaseUploadTarget's result is null, so the reply may leave it out.
  { hostCallId: 'h-3' },
  { hostCallId: 'h-4', result: null },
];
// @ts-expect-error a reply carries a result or an error, never both
const bothReply: HostResponse = { hostCallId: 'h-5', result: 1, error: tooLarge };
const paused: CallErrorCode = 'runtime.paused';
const flowTooLarge: FlowErrorCode = 'upload.too_large';
const close: CloseOptions = { reason: 'host', discard: true };
const configure: ConfigureOptions = {
  uploadMode: 'pulse',
  captions: { autoDownload: 'wifi', autoGenerate: true },
};
// @ts-expect-error autoDownload is 'wifi' | 'never' (O6)
const badCaptions: ConfigureOptions = { captions: { autoDownload: 'always' } };

describe('the host contract', () => {
  it('is major 1, minor 0 (PR1)', () => {
    expect(CONTRACT.major).toBe(1);
    expect(CONTRACT.minor).toBe(0);
    expect(Object.isFrozen(CONTRACT)).toBe(true);
  });

  it('builds every OpenRequest entry', () => {
    expect(opens.map((o) => o.entry)).toEqual(['record', 'record', 'edit', 'export']);
  });

  it('narrows every FlowResult variant', () => {
    expect(results.map(describeResult)).toEqual([
      'sent inst-1:d1',
      'file results/r1.mp4',
      'kept d1',
      'discarded',
      'failed upload.too_large',
    ]);
  });

  it('routes a confirmSend host request to HostServices.confirmSend', async () => {
    expect(request.method).toBe('confirmSend');
    if (request.method !== 'confirmSend' || !services.confirmSend) throw new Error('unreachable');
    await expect(services.confirmSend(request.args)).resolves.toEqual({ confirmedAt: 510 });
    expect(confirmed).toEqual([request.args]);
    await expect(
      services.getUploadTarget({
        draftId: 'd1',
        clientKey: 'k',
        draftKey: 'inst-1:d1',
        context,
        name: draft.name,
        durationMs: draft.durationMs,
        bytes: 99,
        sentAt: 10,
        attempt: 1,
        renewArtifact: false,
      }),
    ).resolves.toMatchObject({ clientKey: 'k' });
  });

  it('carries the PLAN-final §8 amendments as plain JSON', () => {
    const json = JSON.parse(
      JSON.stringify({ draft, replies, paused, flowTooLarge, close, configure, wrapUp }),
    );
    expect(json.draft).toMatchObject({
      draftKey: 'inst-1:d1',
      hasCaptions: true,
      bytes: 12_345_678,
    });
    expect(json.wrapUp).toMatchObject({ requireOnline: true, confirmSend: true });
    expect(json.close).toEqual({ reason: 'host', discard: true });
    expect(json.configure.captions).toEqual({ autoDownload: 'wifi', autoGenerate: true });
    expect([json.paused, json.flowTooLarge, json.replies[1].error.code]).toEqual([
      'runtime.paused',
      'upload.too_large',
      'upload.too_large',
    ]);
    // The @ts-expect-error values above exist only to make tsc prove the shapes.
    expect([noDraftKey, noCaptionsFlag, mismatched, badCaptions, bothReply]).toHaveLength(5);
  });
});
