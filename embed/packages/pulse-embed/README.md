# @mieweb/pulse-embed

The host contract for embedding Pulse (PulseKit) in a Capacitor or Cordova app, as TypeScript
types plus the few runtime helpers every caller needs. The JS client, the adapters and the React
hooks build on it (`./react` and `./testing` are reserved subpaths; they don't exist yet).

## What's here

| Export                 | What it is                                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Types (`src/types.ts`) | The contract v1: `PulseClient`, `OpenRequest`, `FlowResult`, `DraftSummary`, `HostServices`, error codes, events and the bridge envelope.                                                                                                    |
| `CONTRACT`             | `{ major: 1, minor: 0 }`. A client refuses a facade with another major (`contract.unsupported`).                                                                                                                                             |
| `contextKey(kind, id)` | Builds `PulseContext.key` as `` `${kind}:${id.toLowerCase()}` ``. The kind must be `[a-z0-9._-]`, the id `[A-Za-z0-9._:-]` (checked before lowercasing), and the key at most 128 chars; anything else throws a PulseError `invalid_options`. |
| `isPulseError(e)`      | True for an error with `name: 'PulseError'`, a `code`, a `message` and a `callId`.                                                                                                                                                           |

## Contract rules

- Error codes, states, entry names, event names and fields are append-only.
- Unknown fields are ignored on both sides. A missing required field, or a wrong type, is
  `invalid_options`.
- New methods are found through `info().methods`, never by comparing `contract.minor`.
- Everything that crosses the bridge is JSON. Times are integer milliseconds since the epoch.

## Versions

The package version is `0.0.0-dev` in the repo. The release workflow stamps the PulseKit version
(the same as the Pulse app it was built from) from the `pulsekit-v*` tag.

## Development

Inside the Pulse repo the package resolves from source: the root and `embed/` tsconfigs map
`@mieweb/pulse-embed` to `src/`, and so does `jest.config.js`.

```sh
npx tsc --noEmit -p embed/packages/pulse-embed   # the package on its own
npx jest embed/packages/pulse-embed              # its tests
```
