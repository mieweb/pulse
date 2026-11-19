import { describe, expect, it } from '@jest/globals';

import { createFakePulse, runPulseContract } from '@mieweb/pulse-embed/testing';

// The host contract against the fake. PR2-K runs the same suite against the real code.
runPulseContract((setup) => createFakePulse(setup), { describe, it, expect });
