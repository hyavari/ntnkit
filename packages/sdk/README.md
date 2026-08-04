# `@ntnkit/sdk`

NTN-aware client: store-and-forward outbox, pluggable `Transport`, HTTP helper,
optional ntn-in-a-box link-state, and `autoFlush`.

## Install

```bash
pnpm add @ntnkit/sdk
```

Requires **Node.js 24+** (ESM). Pulls in [`@ntnkit/core`](https://www.npmjs.com/package/@ntnkit/core).

For a durable outbox on Node, also add
[`@ntnkit/sqlite`](https://www.npmjs.com/package/@ntnkit/sqlite).

## Usage

```ts
import { DeliveryMode, Priority } from "@ntnkit/core";
import { connect, httpTransport } from "@ntnkit/sdk";

const client = await connect({
  budget: { dailyBytes: 50_000 },
  autoFlush: true,
  transport: httpTransport({ url: "https://example.com/ingest" }),
});

await client.send({
  payload: new TextEncoder().encode('{"ok":true}'),
  priority: Priority.Normal,
  delivery: DeliveryMode.Immediate,
});

await client.close();
```

## `ntnboxLinkState`

Observes an [ntn-in-a-box](https://github.com/hyavari/ntn-in-a-box) API host
(condition poll + SSE) and maps it to `@ntnkit/core` `LinkState` for
`httpTransport({ linkState })`.

```ts
import { connect, httpTransport, ntnboxLinkState } from "@ntnkit/sdk";

const link = ntnboxLinkState({
  apiBaseUrl: "http://10.200.0.1:18080",
  deviceId: "sandbox-0", // default
  terrestrialFallback: true, // dual-path profiles only
});

const client = await connect({
  autoFlush: true,
  transport: httpTransport({
    url: "https://example.com/ingest",
    linkState: () => link.getLinkState(),
  }),
});
```

| Option | Default | Meaning |
|--------|---------|---------|
| `apiBaseUrl` | (required) | ntnbox API base (no trailing slash required) |
| `deviceId` | `sandbox-0` | Device registered by ntnbox |
| `terrestrialFallback` | `false` | Prefer `selected_bearer` / handover SSE; map terr → `LinkState.Terrestrial` |
| `pollIntervalMs` | `1000` | Condition poll interval |
| `sse` | `true` | Subscribe to `/events` |
| `requestTimeoutMs` | `5000` | Per-request timeout |

**Without** `terrestrialFallback`: `in_coverage: false` → `Constrained`
(coverage-gap / store-and-forward path — what `ci_gap` CI uses).

**With** `terrestrialFallback: true` (ntnbox ≥ v0.1.7,
`terrestrial_fallback` profiles such as `geo_blockage_handover`): satellite
outage while terrestrial is selected → `Terrestrial` (Immediate-capable).
If `selected_bearer` disagrees with `in_coverage`, coverage wins (stale route).

Call `await link.close()` when tearing down.

## Docs

Full guide: [ntnkit README](https://github.com/hyavari/ntnkit#readme)

Shaped CI with [ntn-in-a-box](https://github.com/hyavari/ntn-in-a-box).

## License

Apache-2.0
