# `@ntnkit/scan`

Static NTN readiness checks plus the `ntnkit-scan` CLI for CI.

## Install

```bash
pnpm add -D @ntnkit/scan
```

Requires **Node.js 24+** (ESM).

## CLI

```bash
ntnkit-scan --payload-file ./payload.bin [--max-bytes 1200] [--json]
```

Exit codes: `0` = no critical findings, `1` = critical findings, `2` = usage/error.

## Library

```ts
import { scanMessages, hasCritical } from "@ntnkit/scan";
```

## Docs

Full guide: [ntnkit README](https://github.com/hyavari/ntnkit#readme)

## License

Apache-2.0
