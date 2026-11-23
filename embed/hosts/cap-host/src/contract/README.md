# Contract page

The host contract (`runPulseContract`, `embed/packages/pulse-embed/src/testing/contract-suite.ts`)
against the real Pulse plugin, on the phone. The same suite runs in Jest against the fake and against
Pulse's own JavaScript (`embed/src/test-support/contract-parity.test.ts`).

## Build and run

```sh
node embed/hosts/cap-host/src/contract/build.mjs   # writes www/contract/ (generated, not committed)
cd embed/hosts/cap-host && npx cap sync ios
```

Then open the cap-host app on the iPhone, tap **Contract suite** on the host page, and tap **Run the
contract suite**.

- The page signs in as the suite's test account first (`CONTRACT_ACCOUNT`). Start from a fresh install
  of cap-host: a runtime bound to another account answers writes with `restart_required`.
- Before each test that opens Pulse, the page says what to do in each flow (record a clip, then Send,
  say) and waits for **Go**.
- Each line reads `PASS` or `FAIL` with the reason. The summary is logged to the Xcode console as
  `[contract] [...]` too.
- A phone can't arrange everything the suite can in Jest, so these tests are left out: overridden
  `info`, a reload mid-flow, the network, and uploads against a server that never answers.

None of this has run on a phone yet.
