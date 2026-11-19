# @mieweb/pulse-embed

The JavaScript side of embedding Pulse (PulseKit) in a Capacitor or Cordova app: the host contract
as TypeScript types, the client your page calls, React hooks, and a scripted fake for your tests.
It needs one native plugin next to it: `@mieweb/capacitor-pulse` or `cordova-plugin-pulse`.

How to add Pulse to an app, and the full contract, are in the Pulse repo's
[docs/embedding](../../../docs/embedding/README.md).

## What's here

| Import                        | What it gives you                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mieweb/pulse-embed`         | `getPulse()` (the page-wide client) and `createPulseClient(options)`; `contextKey(kind, id)`; `isPulseError(e)`; `CONTRACT`; every contract type (`PulseClient`, `OpenRequest`, `FlowResult`, …). |
| `@mieweb/pulse-embed/react`   | `usePulseAvailability`, `usePresent`, and the drafts hooks `useDrafts`, `useDraft`, `useDraftCounts` (these need contract minor 1). React 18 or later, as an optional peer dependency.            |
| `@mieweb/pulse-embed/testing` | `createFakePulse(script)`, a scripted in-memory Pulse behind a real adapter, and `runPulseContract(maker, { describe, it, expect })`, the host contract as one suite for Jest or Vitest.          |

```ts
import { contextKey, getPulse } from '@mieweb/pulse-embed';

const pulse = getPulse();
await pulse.configure({ uploadMode: 'file', hostName: 'TimeHuddle' });
const result = await pulse.record({
  key: contextKey('ticket', 'TH-482'),
  kind: 'ticket',
  id: 'TH-482',
  label: 'Fix login',
});
```

The client picks its transport itself: `window.__PULSE_ADAPTER__` (test builds), then Capacitor's
`Pulse` plugin, then Cordova's `window.PulseKit`, and otherwise an adapter that reports Pulse as
unavailable, so the same code runs in a desktop browser.

## The fake's server mode

With `createFakePulse({ server: … })` the fake uploads for real: it asks your `HostServices` for an
upload target, sends the video over TUS with `fetch` (a create, then a PATCH per part) and polls the
status route until there is an outcome. It needs no extra dependency.

## Versions

The version is `0.0.0-dev` in the repo. A `pulsekit-v*` tag stamps the release version into this
package, the two plugins and PulseKit itself, and they are published together
([releasing](../../../docs/embedding/releasing.md)). Install all of them at the same exact version.

## Development

Inside the Pulse repo the package resolves from source: the root and `embed/` tsconfigs map
`@mieweb/pulse-embed` to `src/`, and so does `jest.config.js`.

```sh
npx tsc --noEmit -p embed/packages/pulse-embed   # the package on its own
npx jest embed/packages/pulse-embed              # its tests (also part of npm test)
(cd embed/packages/pulse-embed && npm run build) # dist/, as npm gets it
```
