# @mieweb/pulse-embed

The JavaScript side of embedding Pulse (PulseKit) in a Capacitor or Cordova app: the host contract
as TypeScript types, the client your page calls, React hooks, and a scripted fake for your tests.
It needs one native plugin next to it: `@mieweb/capacitor-pulse` or `cordova-plugin-pulse`.

How to add Pulse to an app, step by step, and the full contract are in the Pulse repo's
[docs/embedding](../../../docs/embedding/README.md).

```sh
npm install --save-exact @mieweb/pulse-embed@rc @mieweb/capacitor-pulse@rc   # Capacitor
npm install --save-exact @mieweb/pulse-embed@rc                              # Cordova, then:
npx cordova plugin add cordova-plugin-pulse@rc
```

Releases are prereleases on the npm `rc` tag. Install the client and the plugin at the same exact
version.

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

PulseKit needs `uploadMode: 'file'` in this version: the default, `'pulse'`, ends every flow
`failed` with `unsupported`. Read `pendingResults()` on every page load, and `acknowledge()` each
result once you've handled it.

The client picks its transport itself: `window.__PULSE_ADAPTER__` (test builds), then Capacitor's
`Pulse` plugin, then Cordova's `window.PulseKit`, and otherwise an adapter that reports Pulse as
unavailable, so the same code runs in a desktop browser.

## The fake

`createFakePulse` models the whole contract, the minor-1 methods (drafts, accounts, Pulse uploads)
included, and its default flow ends as a Pulse upload. To match the PulseKit that is released, pass
`flows: [{ result: 'file' }]` and the minor-0 method list as `info.methods`
([example](../../../docs/embedding/README.md#test-without-a-phone)).

### Server mode

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
