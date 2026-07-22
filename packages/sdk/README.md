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

## Docs

Full guide: [ntnkit README](https://github.com/hyavari/ntnkit#readme)

Shaped CI with [ntn-in-a-box](https://github.com/hyavari/ntn-in-a-box).

## License

Apache-2.0
