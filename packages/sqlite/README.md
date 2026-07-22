# `@ntnkit/sqlite`

Node SQLite durable outbox and runtime state for `@ntnkit/sdk`
(`openSqliteStore`). Survives process restarts with at-least-once delivery
semantics; use `dedupKey` for idempotency.

## Install

```bash
pnpm add @ntnkit/sqlite
```

Requires **Node.js 24+**. Native dependency: `better-sqlite3` (build tools may
be needed on first install).

## Usage

```ts
import { connect, httpTransport } from "@ntnkit/sdk";
import { openSqliteStore } from "@ntnkit/sqlite";

const store = await openSqliteStore({ path: "./outbox.db" });
const client = await connect({
  store,
  transport: httpTransport({ url: "https://example.com/ingest" }),
  autoFlush: true,
});
```

Single-writer (one process) in v1. Budget day boundaries are UTC.

## Docs

Full guide: [ntnkit README](https://github.com/hyavari/ntnkit#readme)

## License

Apache-2.0
