/**
 * @mieweb/pulse-embed/testing: a scripted in-memory Pulse (createFakePulse) and the host contract
 * as a framework-agnostic suite (runPulseContract).
 *
 * A host's tests use the fake's client directly; a test build installs its adapter before the
 * page's first getPulse(), so the app runs unchanged against it (Playwright, a dev server):
 *
 *   import { createFakePulse } from '@mieweb/pulse-embed/testing';
 *   const fake = createFakePulse({ flows: [{ result: 'sent' }] });
 *   window.__PULSE_ADAPTER__ = fake.adapter;
 */
export type { FakeFlowStep, FakePulse, FakePulseScript } from '../types';
export {
  createFakePulse,
  FAKE_ACCOUNT,
  type FakePulseHandle,
  type FakeRelatedPart,
  type FakeScript,
  type FakeStep,
  type FakeUploadEvent,
} from './fake';
export {
  runPulseContract,
  type PulseContractMaker,
  type PulseContractSetup,
  type PulseContractSubject,
  type PulseContractTest,
} from './contract-suite';
export type { FetchInitLike, FetchLike, FetchResponseLike } from './tus';
