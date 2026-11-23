import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('expo-crypto', () => {
  let n = 0;
  return { randomUUID: () => `call-${++n}` };
});
jest.mock('./upload-log', () => ({ uploadLog: { info: () => {}, warn: () => {} } }));

/* eslint-disable import/first -- the mocks above must be registered before these load */
import {
  confirmSend,
  forgetUploadTokens,
  getUploadTarget,
  HOST_REQUEST_TIMEOUT_MS,
  hostRequest,
  HostRequestError,
  hostRequestTimedOut,
  refreshUploadToken,
  releaseUploadTarget,
  respondToHostRequest,
  setHostRequestSink,
  uploadToken,
  type HostRequestPayload,
  type UploadTargetRequest,
} from './host-services';
/* eslint-enable import/first */

const sent: HostRequestPayload[] = [];
const last = () => sent[sent.length - 1];

const TARGET_REQUEST: UploadTargetRequest = {
  draftId: 'd1',
  clientKey: 'inst:d1:0123456789abcdef',
  draftKey: 'inst:d1',
  context: { key: 'ticket:42', kind: 'ticket', id: '42', label: 'Fix login' },
  name: 'Fix login',
  durationMs: 4000,
  bytes: 1000,
  sentAt: 1_790_000_000_000,
  attempt: 1,
  renewArtifact: false,
};
const TARGET = {
  uploadId: 'u1',
  endpoint: 'https://host/pulsevault',
  artifactId: 'a1',
  token: 'secret-token',
  expiresAt: 1_790_000_900_000,
  clientKey: TARGET_REQUEST.clientKey,
};

/** The error a request rejected with. */
async function failure(p: Promise<unknown>): Promise<HostRequestError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HostRequestError);
    return e as HostRequestError;
  }
  throw new Error('expected the request to fail');
}

beforeEach(() => {
  sent.length = 0;
  jest.useFakeTimers({ now: 1_790_000_000_000 });
  setHostRequestSink((payload) => sent.push(payload));
});

afterEach(() => {
  setHostRequestSink(null);
  forgetUploadTokens();
  jest.useRealTimers();
});

describe('host requests', () => {
  it('emits a hostRequest with a 20 s deadline and resolves on the host’s answer', async () => {
    const answer = getUploadTarget(TARGET_REQUEST);
    expect(sent).toEqual([
      {
        hostCallId: expect.stringMatching(/^h-call-\d+$/),
        method: 'getUploadTarget',
        args: TARGET_REQUEST,
        deadline: 1_790_000_000_000 + 20_000,
      },
    ]);
    respondToHostRequest({ hostCallId: last().hostCallId, result: TARGET });
    await expect(answer).resolves.toEqual(TARGET);
  });

  it('fails host.unavailable, unanswered, when the host says nothing in 20 s', async () => {
    const answer = failure(refreshUploadToken({ uploadId: 'u1', clientKey: 'k', draftId: 'd1' }));
    jest.advanceTimersByTime(HOST_REQUEST_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    jest.advanceTimersByTime(1);
    const error = await answer;
    expect(error).toMatchObject({ code: 'host.unavailable', unanswered: true });
    // A late answer changes nothing.
    respondToHostRequest({ hostCallId: sent[0].hostCallId, result: { token: 't', expiresAt: 1 } });
    expect(uploadToken('u1')).toBeNull();
  });

  it('fails at once when the facade says the request timed out', async () => {
    const answer = failure(hostRequest('confirmSend', {} as never));
    hostRequestTimedOut(last().hostCallId);
    expect(await answer).toMatchObject({ code: 'host.unavailable', unanswered: true });
  });

  it('fails unanswered with no host to ask, or when the host goes away mid-request', async () => {
    const waiting = failure(hostRequest('confirmSend', {} as never));
    setHostRequestSink(null);
    expect(await waiting).toMatchObject({ code: 'host.unavailable', unanswered: true });
    expect(await failure(hostRequest('confirmSend', {} as never))).toMatchObject({
      code: 'host.unavailable',
      unanswered: true,
    });
  });

  it.each([
    ['destination.gone', 'destination.gone'],
    ['upload.refused', 'upload.refused'],
    ['upload.too_large', 'upload.too_large'],
    ['no_account', 'no_account'],
    ['host.unavailable', 'host.unavailable'],
    ['some.other', 'host.unavailable'],
  ])('maps a host error %s to %s, answered', async (code, mapped) => {
    const answer = failure(getUploadTarget(TARGET_REQUEST));
    respondToHostRequest({ hostCallId: last().hostCallId, error: { code, message: 'no' } });
    expect(await answer).toMatchObject({ code: mapped, unanswered: false });
  });

  it('refuses an answer Pulse can’t use as host_misconfigured', async () => {
    const target = failure(getUploadTarget(TARGET_REQUEST));
    respondToHostRequest({ hostCallId: last().hostCallId, result: { ...TARGET, token: '' } });
    expect(await target).toMatchObject({ code: 'host_misconfigured' });
    const confirm = failure(confirmSend({} as never));
    respondToHostRequest({ hostCallId: last().hostCallId, result: { confirmedAt: 'now' } });
    expect(await confirm).toMatchObject({ code: 'host_misconfigured' });
  });

  it('keeps tokens in memory, replaced on refresh and forgotten on release', async () => {
    const target = getUploadTarget(TARGET_REQUEST);
    respondToHostRequest({ hostCallId: last().hostCallId, result: TARGET });
    await target;
    expect(uploadToken('u1')).toEqual({ token: 'secret-token', expiresAt: TARGET.expiresAt });

    const fresh = refreshUploadToken({ uploadId: 'u1', clientKey: 'k', draftId: 'd1' });
    respondToHostRequest({
      hostCallId: last().hostCallId,
      result: { token: 'fresh-token', expiresAt: 5 },
    });
    await fresh;
    expect(uploadToken('u1')).toEqual({ token: 'fresh-token', expiresAt: 5 });

    // Fire and forget: a host without a handler (or that never answers) is fine.
    const release = releaseUploadTarget({ uploadId: 'u1', clientKey: 'k', reason: 'edited' });
    expect(uploadToken('u1')).toBeNull();
    respondToHostRequest({
      hostCallId: last().hostCallId,
      error: { code: 'method.unsupported', message: 'no handler' },
    });
    await expect(release).resolves.toBeUndefined();
  });
});
