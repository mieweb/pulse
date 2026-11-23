import type { FlowResult, FlowResultBase } from '@mieweb/pulse-embed';

import { topScreen, type FlowState } from './reducer';

/**
 * The FlowResult for an ended flow, as plain JSON (contract rule 5): no undefined values, times in
 * integer milliseconds. The shell writes it to `results/<requestId>.json` before it tells the
 * host. Null while the flow is still open.
 */
export function flowResult(state: FlowState, endedAt: number): FlowResult | null {
  const { end } = state;
  if (!end) return null;
  const base: FlowResultBase = {
    requestId: state.requestId,
    entry: state.entry,
    // A failure before the first frame never showed a screen.
    endedOn: state.mounted ? topScreen(state) : null,
    stage: state.stage,
    context: state.context,
    endedAt: Math.round(endedAt),
  };
  switch (end.status) {
    case 'completed':
      return end.mode === 'file'
        ? {
            ...base,
            status: 'completed',
            mode: 'file',
            draftId: end.draftId,
            export: end.export,
            durationMs: Math.round(end.durationMs),
            ...(end.project ? { project: end.project } : null),
          }
        : {
            ...base,
            status: 'completed',
            mode: 'pulse',
            draftId: end.draftId,
            sentAt: end.sentAt,
            clientKey: end.clientKey,
            draftKey: end.draftKey,
            ...(end.confirmedAt !== undefined ? { confirmedAt: end.confirmedAt } : null),
          };
    case 'closed':
      return { ...base, status: 'closed', reason: end.reason, draftId: end.draftId };
    case 'canceled':
      return {
        ...base,
        status: 'canceled',
        reason: end.reason,
        ...(end.draftId !== undefined ? { draftId: end.draftId } : null),
      };
    case 'failed':
      return {
        ...base,
        status: 'failed',
        error: withoutUndefined(end.error),
        ...(end.draftId !== undefined ? { draftId: end.draftId } : null),
      };
  }
}

/** A copy without the keys whose value is undefined (JSON would drop them; the host never sees them). */
function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
