#!/bin/sh
# Run ci-smoke under ntnbox (Linux native or macOS Docker proxy).
#
# Usage (from ntn-in-a-box repo root):
#   ./ntnbox run --addr 0.0.0.0:18080 \
#     --profile ../ntnkit/test/profiles/ci_gap.yaml -- \
#     env NTNBOX_API_BASE=http://10.200.0.1:18080 \
#     ../ntnkit/scripts/ntnbox-ci-smoke.sh
#
# On macOS Docker, ntnbox bind-mounts this script + the ntnkit tree and uses
# Linux Node/pnpm from the image. A named volume overlays node_modules so
# Darwin host modules are not used.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "ntnbox-ci-smoke: pnpm not found (rebuild ntnbox image: make docker)" >&2
  exit 127
fi

# Fresh / empty overlay volumes need a Linux install once.
if [ ! -d node_modules/.pnpm ]; then
  echo "ntnbox-ci-smoke: installing Linux deps (first run or empty volume)..." >&2
  pnpm install --frozen-lockfile
fi

# Ensure esbuild native binary exists (required by tsx).
esbuild_ok=0
if [ -d node_modules/.pnpm ]; then
  # shellcheck disable=SC2044
  for candidate in $(find node_modules/.pnpm -path '*/esbuild/bin/esbuild' -type f 2>/dev/null); do
    if [ -x "$candidate" ]; then
      esbuild_ok=1
      break
    fi
  done
fi
if [ "$esbuild_ok" -eq 0 ]; then
  for candidate in node_modules/@esbuild/*/bin/esbuild; do
    if [ -x "$candidate" ]; then
      esbuild_ok=1
      break
    fi
  done
fi
if [ "$esbuild_ok" -eq 0 ]; then
  echo "ntnbox-ci-smoke: rebuilding esbuild..." >&2
  pnpm rebuild esbuild >/dev/null 2>&1 || pnpm install --frozen-lockfile
fi

exec pnpm --filter @ntnkit/example-ci-smoke start
