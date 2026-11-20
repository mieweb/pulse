import { describe, expect, it } from '@jest/globals';

import { fakeContractMaker, runPulseContract } from '@mieweb/pulse-embed/testing';

// The host contract against the fake. contract-parity.test.ts (embed/src/test-support) runs the
// same suite against the real Pulse JS code.
runPulseContract(fakeContractMaker(), { describe, it, expect });
