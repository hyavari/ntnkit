#!/usr/bin/env bash
# Verify publishable tarballs: dist present, no workspace: protocol.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${PACK_CHECK_SKIP_BUILD:-}" != "1" ]]; then
  pnpm build
fi

PACKAGES=(core sdk scan sqlite)
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

for name in "${PACKAGES[@]}"; do
  pkg="packages/$name"
  echo "==> packing @ntnkit/$name"
  version="$(node -p "require('./$pkg/package.json').version")"
  expected_name="@ntnkit/$name"
  (
    cd "$pkg"
    pnpm pack --pack-destination "$tmpdir" >/dev/null
  )
  # pnpm names tarballs by unscoped name: ntnkit-<pkg>-<version>.tgz
  tgz="$tmpdir/ntnkit-$name-$version.tgz"
  if [[ ! -f "$tgz" ]]; then
    # Fallback: single .tgz written for this package into tmpdir this iteration
    shopt -s nullglob
    matches=("$tmpdir"/*"$name"*.tgz)
    shopt -u nullglob
    if [[ ${#matches[@]} -ne 1 ]]; then
      echo "FAIL: expected one tarball for $name under $tmpdir, found: ${matches[*]:-none}"
      exit 1
    fi
    tgz="${matches[0]}"
  fi
  echo "packed: $tgz"
  listing="$(tar -tzf "$tgz")"
  echo "$listing" | grep -E 'package/dist/index\.js' >/dev/null \
    || { echo "FAIL: $name tarball missing package/dist/index.js"; exit 1; }
  echo "$listing" | grep -E 'package/dist/index\.d\.ts' >/dev/null \
    || { echo "FAIL: $name tarball missing package/dist/index.d.ts"; exit 1; }
  if [[ "$name" == "scan" ]]; then
    echo "$listing" | grep -E 'package/dist/cli\.js' >/dev/null \
      || { echo "FAIL: scan tarball missing package/dist/cli.js"; exit 1; }
  fi
  if echo "$listing" | grep -E 'package/src/' >/dev/null; then
    echo "FAIL: $name tarball includes src/"
    exit 1
  fi
  meta="$(tar -xOf "$tgz" package/package.json)"
  if echo "$meta" | grep -F 'workspace:' >/dev/null; then
    echo "FAIL: $name package.json still has workspace: protocol"
    echo "$meta"
    exit 1
  fi
  packed_version="$(node -e "const m=JSON.parse(process.argv[1]); if(!m.version) process.exit(2); process.stdout.write(m.version)" "$meta")"
  packed_name="$(node -e "const m=JSON.parse(process.argv[1]); process.stdout.write(m.name||'')" "$meta")"
  if [[ "$packed_version" != "$version" ]]; then
    echo "FAIL: $name packed version $packed_version != source $version"
    exit 1
  fi
  if [[ "$packed_name" != "$expected_name" ]]; then
    echo "FAIL: $name packed name $packed_name != $expected_name"
    exit 1
  fi
done

echo "pack-check: OK"
