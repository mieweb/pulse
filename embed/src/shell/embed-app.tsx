import type { FlowResult, PulseErrorInfo } from '@mieweb/pulse-embed';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PulseCore } from '@/core/pulse-core';
import type { FatalStorage } from '@/core/recovery/types';
import { installLogCapture } from '@/features/logs/logger';
import { ToastProvider } from '@/features/toast/toast-provider';

import type { FlowState } from '../flow/reducer';
import { flowResult } from '../flow/result';
import { planOpen, type EmbedProps, type OpenPlan } from './entries';
import { createFlowController } from './flow-controller';
import { FlowStack } from './flow-stack';
import { createFlowStore } from './flow-store';
import { removeDraft } from './library';
import { embedChannel } from './channel';
import { createUiSender } from './messaging';
import { startupFailure, writeFlowResult } from './results';
import { themeOf, themeOverrides } from './theme';

/**
 * The embedded Pulse runtime for one request, loaded by embed-root.tsx once the storage roots are
 * set. It checks the request, runs the flow under PulseCore (the library gate, theme, status-bar
 * port), and ends it with exactly one result: written to `results/<requestId>.json`, then
 * `pulse.result` (native-bridge.md §6.2, §8.1).
 */
export function EmbedApp(props: EmbedProps & { requestId: string }) {
  const [plan] = useState(() => planOpen(props));
  const { requestId } = props;

  useEffect(() => {
    if (plan.ok) return;
    console.log(`[embed] ${requestId} refused: ${plan.error.code} ${plan.error.message}`);
    // Without an entry there is no result to write; the facade fails the flow from the message.
    if (!plan.entry) embedChannel().error(requestId, plan.error.message);
    else
      deliver(
        startupFailure({ requestId, entry: plan.entry, error: plan.error, endedAt: Date.now() }),
      );
  }, [plan, requestId]);

  if (!plan.ok) return <View style={styles.blank} />;
  return <EmbedFlow plan={plan} />;
}

function EmbedFlow({ plan }: { plan: OpenPlan }) {
  const { requestId, request, config } = plan;
  const [store] = useState(() =>
    createFlowStore({ requestId, request, onEnd: (state) => void finish(state) }),
  );
  const [controller] = useState(() => createFlowController(store, requestId));
  const [ui] = useState(() => createUiSender(embedChannel().ui));
  const [theme] = useState(() => themeOverrides(themeOf(request, config)));

  // The host's close (`pulse.cmd close {reason, discard?}`), for as long as this flow is up.
  useEffect(
    () =>
      embedChannel().handle('close', async (args) => {
        await controller.hostClose(args.discard === true);
        return null;
      }),
    [controller],
  );

  // B6: a library Pulse can't open or migrate ends the flow; `reset` is the person asking for this
  // account's Pulse data to be reset, which the host's purge does (PR2) once the flow has ended.
  const onFatalStorage = useCallback(
    (fatal: FatalStorage) =>
      void controller.fail({
        code: fatal.code,
        message: fatal.message,
        ...(fatal.reset ? { details: { reset: true } } : null),
      }),
    [controller],
  );

  const onMissingDraft = useCallback(() => {
    const error: PulseErrorInfo = {
      code: 'not_found',
      message: `Pulse has no draft ${plan.draftId}.`,
      recoverable: false,
      callId: '',
      requestId,
    };
    // Through the store, so the result carries the request's context and a late host close
    // finds the flow already ended.
    store.missing(error);
  }, [plan.draftId, requestId, store]);

  return (
    <PulseCore
      mode="embedded"
      theme={theme}
      wrap={ToastProvider}
      onBoot={installLogCapture}
      onFatalStorage={onFatalStorage}>
      <FlowStack
        store={store}
        controller={controller}
        config={config}
        ui={ui}
        draftId={plan.draftId}
        onMissingDraft={onMissingDraft}
      />
    </PulseCore>
  );
}

/** The flow ended: carry out the draft it leaves behind, then hand the host its result. */
async function finish(state: FlowState): Promise<void> {
  if (state.deleteDraft) {
    try {
      await removeDraft(state.deleteDraft);
    } catch (e) {
      console.warn(`[embed] couldn't delete draft ${state.deleteDraft}`, e);
    }
  }
  const result = flowResult(state, Date.now());
  if (result) deliver(result);
}

/** Write the result file, then tell the facade; if the file can't be written, say why. */
function deliver(result: FlowResult): void {
  const channel = embedChannel();
  try {
    writeFlowResult(result);
  } catch (e) {
    console.warn(`[embed] couldn't write the result for ${result.requestId}`, e);
    channel.error(result.requestId, `Pulse couldn't save its result: ${String(e)}`);
    return;
  }
  console.log(`[embed] ${result.requestId} ended ${result.status} on ${result.endedOn}`);
  channel.result(result.requestId);
}

const styles = StyleSheet.create({ blank: { flex: 1, backgroundColor: '#000' } });
