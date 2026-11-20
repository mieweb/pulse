/**
 * Export's Send in uploadMode 'pulse' (AD23, PLAN-final §5.1 B2/B3, §6.1): the orchestration
 * around `outbox.sendDraft`, with the outbox, the merge, the network and the draft's
 * `host_confirmed_at` injected, so it runs (and is tested) without a screen.
 *
 * 1. The type's checks run again at the tap (`requireName`, then `requireOnline`): the network can
 *    drop between render and tap. Blocked, nothing is asked of the outbox.
 * 2. `sendDraft` freezes the draft as a job, merges it when the saved export is stale and writes
 *    its send files. Then the type's `maxBytes` refuses it before any confirm (the server would
 *    refuse it anyway; the host must not clock for a video it will never take).
 * 3. A type with `confirmSend` asks the host once ("Clocking out…"). A draft whose confirm already
 *    ran (`host_confirmed_at`: an Edit after its Send) isn't asked again and keeps its original
 *    `sentAt`; any other Send stamps a fresh one (outbox `nextJobState`). On success the outbox
 *    records `host_confirmed_at` and queues the job; on failure nothing is queued and Export stays,
 *    with "Couldn’t clock out. Your video is saved." [Try again] [Keep draft].
 * 4. Queued: the flow ends `completed{mode:'pulse', sentAt, clientKey, draftKey, confirmedAt?}`.
 *
 * Pulse knows nothing about clocks (AD10): the clock wording below is keyed by the two clock
 * upload type ids the host sends (`clock.wrapup`, `clock.plan`), and any other `confirmSend` type
 * gets neutral wording.
 */
import type { SendOptions, SendResult, SendStage } from '@/features/upload/core/outbox';

import { checkSend, tooLargeText, type SendBlock, type UploadRules } from './send-checks';

/** The primary action's text when the type names none and the draft has no place label. */
export const SEND_LABEL = 'Send';
/** The primary action while the merge (or the send files) runs. */
export const PREPARING_SEND_LABEL = 'Preparing video…';

/** What Export says around a type's confirm, and the keep answer of the X sheet before Send. */
export type ConfirmCopy = {
  /** The primary action while the host's `confirmSend` runs. */
  confirming: string;
  /** The line shown when the confirm failed, with Try again / Keep draft. */
  failed: string;
  /** The X sheet's keep answer for this type (a clock type says what keeping leaves behind). */
  keepDraft: string;
};

export const TRY_AGAIN_LABEL = 'Try again';
export const KEEP_DRAFT_LABEL = 'Keep draft';

const CLOCK_COPY: Record<string, ConfirmCopy> = {
  'clock.wrapup': {
    confirming: 'Clocking out…',
    failed: 'Couldn’t clock out. Your video is saved.',
    keepDraft: 'Keep draft (you’re still clocked in)',
  },
  'clock.plan': {
    confirming: 'Clocking in…',
    failed: 'Couldn’t clock in. Your video is saved.',
    keepDraft: 'Keep draft (you’re still clocked out)',
  },
};

const NEUTRAL_COPY: ConfirmCopy = {
  confirming: 'Sending…',
  failed: 'Couldn’t send. Your video is saved.',
  keepDraft: KEEP_DRAFT_LABEL,
};

/** Whether a stored upload type (parsed `drafts.upload_type_json`) asks the host to confirm. */
export function wantsConfirm(uploadType: unknown): boolean {
  return (
    typeof uploadType === 'object' &&
    uploadType !== null &&
    (uploadType as { confirmSend?: unknown }).confirmSend === true
  );
}

/** The confirm wording for a stored upload type (lenient: anything unknown is neutral). */
export function confirmCopy(uploadType: unknown): ConfirmCopy {
  if (!wantsConfirm(uploadType)) return NEUTRAL_COPY;
  const id = (uploadType as { id?: unknown }).id;
  return (typeof id === 'string' && CLOCK_COPY[id]) || NEUTRAL_COPY;
}

/** Export's primary action: the type's `sendLabel`, else "Send to <place>", else "Send". */
export function sendLabel(rules: UploadRules | null, contextLabel: string | null): string {
  if (rules?.sendLabel) return rules.sendLabel;
  const place = contextLabel?.trim();
  return place ? `Send to ${place}` : SEND_LABEL;
}

/** A Send that reached the outbox: what the flow's `completed{mode:'pulse'}` carries. */
export type SentDraft = SendResult & { confirmedAt?: number };

/** Where a Send in flight is: Export's busy states. */
export type SendPhase = 'merging' | 'confirming';

export type SendOutcome =
  /** Queued (or already queued with no edit since): close with these keys. */
  | { status: 'sent'; sent: SentDraft }
  /** A check failed at the tap: nothing was started. */
  | { status: 'blocked'; block: SendBlock }
  /** Over the type's `maxBytes` once the send files were written: no job, nothing confirmed. */
  | { status: 'tooLarge'; maxBytes: number; text: string }
  /** The host's confirm failed (refused, unreachable, timed out): no job, still a draft. */
  | { status: 'confirmFailed'; message: string }
  /** Anything else (the merge failed, the draft is locked or gone). */
  | { status: 'failed'; message: string };

export type SendInput = {
  draftId: string;
  rules: UploadRules | null;
  /** The draft's own name (for `requireName`). */
  name: string | null;
  /** Whether the draft can be edited (default true); see `checkSend`. */
  editable?: boolean;
};

export type SendFlowDeps = {
  /** The network now (re-checked at the tap). */
  isOnline: () => boolean;
  /** `outbox.sendDraft`. */
  sendDraft: (
    draftId: string,
    merge: () => Promise<{ durationMs: number }>,
    options?: SendOptions,
  ) => Promise<SendResult>;
  /** The draft's merged video: the saved export when current, else a fresh merge. */
  merge: () => Promise<{ durationMs: number }>;
  /** The draft's `host_confirmed_at` now, or null. */
  confirmedAt: (draftId: string) => number | null;
};

/** The `maxBytes` refusal, thrown from `beforeConfirm` so the outbox leaves no job behind. */
class TooLarge extends Error {
  readonly code = 'upload.too_large';
  constructor(
    readonly maxBytes: number,
    bytes: number,
  ) {
    super(`The video is ${bytes} bytes, over its upload type's ${maxBytes}.`);
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Run one Send. Never rejects: every way it ends is a `SendOutcome`. `onPhase` hears the busy
 * states as the outbox reaches them ('confirming' only when the host is actually asked).
 */
export async function runSend(
  { draftId, rules, name, editable = true }: SendInput,
  deps: SendFlowDeps,
  onPhase?: (phase: SendPhase) => void,
): Promise<SendOutcome> {
  // At the tap, with the network as it is now. The size isn't known yet: it's checked below.
  const check = checkSend({ rules, name, online: deps.isOnline(), exportBytes: null, editable });
  if (check.block) return { status: 'blocked', block: check.block };

  const maxBytes = rules?.maxBytes ?? null;
  // Set from the outbox's callback: read after the await, so not narrowed to its initial null.
  let stage = null as SendStage | null;
  try {
    const sent = await deps.sendDraft(draftId, deps.merge, {
      onStage: (s) => {
        stage = s;
        if (s === 'merging' || s === 'confirming') onPhase?.(s);
      },
      beforeConfirm: ({ bytesTotal }) => {
        if (maxBytes != null && bytesTotal > maxBytes) throw new TooLarge(maxBytes, bytesTotal);
      },
    });
    const confirmedAt = deps.confirmedAt(draftId);
    return {
      status: 'sent',
      sent: { ...sent, ...(confirmedAt != null ? { confirmedAt } : null) },
    };
  } catch (e) {
    if (e instanceof TooLarge) {
      return { status: 'tooLarge', maxBytes: e.maxBytes, text: tooLargeText(e.maxBytes) };
    }
    if (stage === 'confirming') return { status: 'confirmFailed', message: messageOf(e) };
    return { status: 'failed', message: messageOf(e) };
  }
}
