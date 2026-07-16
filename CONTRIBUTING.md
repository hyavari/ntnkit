# Contributing to ntnkit

Thanks for helping improve satellite-ready application tooling.

## Setup

Requires Node.js 20+ and [pnpm](https://pnpm.io) 10+. Use **pnpm only** (`npm install` will fail on this workspace).

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

## Packages

| Package | Guidelines |
|---------|------------|
| `@ntnkit/core` | Pure logic only — no I/O, no `fetch`, no filesystem |
| `@ntnkit/sdk` | Client, outbox, transports; keep policy decisions in core |
| `@ntnkit/scan` | Deterministic rules; CLI exit codes matter for CI |

## Pull requests

1. Keep changes focused and easy to review
2. Add or update tests for behavior you change
3. Run `pnpm test`, `pnpm typecheck`, and `pnpm lint` before opening the PR
4. Update the public [README](README.md) if you change user-facing API or behavior

## Testing tips

```bash
# Unit / integration suite
pnpm test

# Examples
pnpm --filter @ntnkit/example-ci-smoke start
NTNKIT_SIMULATE_WINDOW=1 pnpm --filter @ntnkit/example-ci-smoke start
```

If you have [ntn-in-a-box](https://github.com/hyavari/ntn-in-a-box) available, running examples under a profile is especially valuable:

```bash
ntnbox run --profile ../ntnkit/test/profiles/leo_pass_90s.yaml -- \
  pnpm --dir ../ntnkit/examples/ci-smoke start
```

## License

By contributing, you agree that your contributions will be licensed under the Apache-2.0 license of this project.
