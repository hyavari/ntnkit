# Contributing to ntnkit

Thanks for helping improve satellite-ready application tooling.

## Setup

Requires Node.js 24+ and [pnpm](https://pnpm.io) 10+. Use **pnpm only** (`npm install` will fail on this workspace).

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
| `@ntnkit/sqlite` | Node durable store only; keep native deps out of sdk/core |
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

## Publishing (maintainers)

1. Bump all four `@ntnkit/*` versions together.
2. `pnpm pack:check` (asserts `dist/`, `README.md`, `LICENSE`, no `workspace:`).
3. Publish in order: `core` → `sdk` / `scan` → `sqlite`, with
   `--access public --no-git-checks`.
4. Confirm packages are **public** (`npm access get status @ntnkit/sdk`). First
   publish under a new org can land private — fix with
   `npm access set status=public @ntnkit/<pkg>`.
5. Tag `vX.Y.Z` and push. Subsequent tags can use
   [`.github/workflows/publish.yml`](.github/workflows/publish.yml) once each
   package has an npm **trusted publisher** for this repo + workflow
   (npmjs.com → package → Settings → Trusted Publisher), or an `NPM_TOKEN`
   secret.

Smoke from a clean dir with the public registry (avoid corporate mirrors):

```bash
pnpm add @ntnkit/sdk@latest --registry=https://registry.npmjs.org/
```

## License

By contributing, you agree that your contributions will be licensed under the Apache-2.0 license of this project.
