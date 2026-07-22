#!/usr/bin/env bash
# Verify publishable tarballs: dist present, no workspace: protocol.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pnpm build

PACKAGES=(core sdk scan sqlite)
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

for name in "${PACKAGES[@]}"; do
  pkg="packages/$name"
  echo "==> packing @ntnkit/$name"
  (
    cd "$pkg"
    tgz="$(pnpm pack --pack-destination "$tmpdir" | tail -n1)"
    echo "packed: $tgz"
    listing="$(tar -tzf "$tgz")"
    echo "$listing" | grep -E 'package/dist/' >/dev/null \
      || { echo "FAIL: $name tarball missing package/dist/"; exit 1; }
    if echo "$listing" | grep -E 'package/src/' >/dev/null; then
      echo "FAIL: $name tarball includes src/"; exit 1
    fi
    meta="$(tar -xOf "$tgz" package/package.json)"
    if echo "$meta" | grep -F 'workspace:' >/dev/null; then
      echo "FAIL: $name package.json still has workspace: protocol"
      echo "$meta"
      exit 1
    fi
    echo "$meta" | grep -F '"version": "0.1.0"' >/dev/null \
      || { echo "FAIL: $name version is not 0.1.0"; exit 1; }
  )
done

echo "pack-check: OK"
