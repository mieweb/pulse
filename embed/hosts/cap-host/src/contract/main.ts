import { createCapacitorAdapter } from '../../../../packages/pulse-embed/src/adapters/capacitor';
import { createPulseClient } from '../../../../packages/pulse-embed/src/client';
import {
  CONTRACT_ACCOUNT,
  runPulseContract,
  type PulseContractSetup,
  type PulseContractSubject,
} from '../../../../packages/pulse-embed/src/testing/contract-suite';
import type { FakeStep } from '../../../../packages/pulse-embed/src/testing/fake';
import type { PulseAdapter } from '../../../../packages/pulse-embed/src/types';
import { createHarness, type Outcome } from './harness';

/**
 * The host contract (runPulseContract) against the real plugin, on the phone. The person plays
 * each flow: before a test that opens Pulse, the page says what to do in it and waits for Go.
 * What a phone can't arrange is left out: overridden info, a reload mid-flow, the network, and an
 * upload server that never answers.
 */

const $ = (id: string) => document.getElementById(id) as HTMLElement;

function line(text: string, kind: 'ok' | 'fail' | 'note' = 'note'): void {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = text;
  $('results').appendChild(li);
  li.scrollIntoView({ block: 'nearest' });
}

/** What the person does in one flow. */
function say(step: FakeStep): string {
  const wait = step.afterMs ? ', keep it open a few seconds, then' : ',';
  switch (step.result) {
    case 'sent':
      return `record a clip${wait} Send`;
    case 'file':
      return `record a clip${wait} Use this video`;
    case 'kept':
      return `record a clip (or add one)${wait} close with X → Keep`;
    case 'discarded':
      return 'close with X without recording';
    case 'failed':
      return `make it fail with ${step.code}`;
  }
}

/** Shows the flows a test opens and resolves when the person taps Go (at once with none). */
function ready(setup: PulseContractSetup): Promise<void> {
  if (setup.flows.length === 0) return Promise.resolve();
  const steps = setup.flows.map((s, i) => `${i + 1}. ${say(s)}`).join('\n');
  $('steps').textContent = `Each time Pulse opens in this test (the last repeats):\n${steps}`;
  const go = $('go') as HTMLButtonElement;
  go.disabled = false;
  return new Promise((resolve) => {
    go.onclick = () => {
      go.disabled = true;
      resolve();
    };
  });
}

/** A client of its own per test: its listeners go with it, so host services don't pile up. */
function scoped(base: PulseAdapter): { adapter: PulseAdapter; dispose: () => void } {
  const stops: (() => void)[] = [];
  return {
    adapter: {
      ...base,
      subscribe(cb) {
        const stop = base.subscribe(cb);
        stops.push(stop);
        return stop;
      },
    },
    dispose: () => stops.splice(0).forEach((stop) => stop()),
  };
}

async function main(): Promise<void> {
  const base = createCapacitorAdapter();
  if (!base || !(await base.present())) {
    line('No Pulse plugin here: open this page in the cap-host app.', 'fail');
    return;
  }
  // The data tests sign in as the contract account; doing it first keeps every write in the
  // namespace Pulse's runtime is bound to (another one answers restart_required).
  await createPulseClient({ adapter: base }).setAccount(CONTRACT_ACCOUNT);

  const h = createHarness();
  runPulseContract(
    async (setup): Promise<PulseContractSubject> => {
      await ready(setup);
      const s = scoped(base);
      return { client: createPulseClient({ adapter: s.adapter }), dispose: s.dispose };
    },
    h,
    { can: { info: false, reload: false, network: false, server: false }, waitMs: 30_000 },
  );
  line(`${h.names().length} tests (the rest need what a phone can't arrange).`);
  const outcomes: Outcome[] = await h.run((o) =>
    line(
      `${o.ok ? 'PASS' : 'FAIL'} ${o.name} (${o.ms} ms)${o.error ? `: ${o.error}` : ''}`,
      o.ok ? 'ok' : 'fail',
    ),
  );
  const failed = outcomes.filter((o) => !o.ok).length;
  $('steps').textContent = '';
  line(`Done: ${outcomes.length - failed} passed, ${failed} failed.`, failed ? 'fail' : 'ok');
  console.log(`[contract] ${JSON.stringify(outcomes)}`);
}

$('start').addEventListener('click', () => {
  ($('start') as HTMLButtonElement).disabled = true;
  main().catch((e: unknown) => line(`The run stopped: ${String(e)}`, 'fail'));
});
