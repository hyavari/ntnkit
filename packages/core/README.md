# `@ntnkit/core`

Pure application-layer logic for NTN-aware apps: message model, send policy
(`shouldSend`), full-jitter backoff, and daily `ByteBudget`.

No I/O, no `fetch`, no filesystem — safe to use from any JS runtime.

## Install

```bash
pnpm add @ntnkit/core
```

Requires **Node.js 24+** (ESM).

## Usage

```ts
import { DeliveryMode, Priority, shouldSend } from "@ntnkit/core";

const decision = shouldSend({
  priority: Priority.Normal,
  delivery: DeliveryMode.NextWindow,
  linkState: "satellite_window_open",
  payloadBytes: 120,
  budgetRemaining: 50_000,
});
```

Most apps should depend on [`@ntnkit/sdk`](https://www.npmjs.com/package/@ntnkit/sdk)
instead and let the client drive policy.

## Docs

Full guide: [ntnkit README](https://github.com/hyavari/ntnkit#readme)

## License

Apache-2.0
