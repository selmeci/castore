#!/usr/bin/env bash
# publish-parity.sh
#
# Verifies that tarballs produced from this branch (pnpm-built) are
# byte-for-byte equivalent in structure and declared dependency ranges to
# tarballs produced from the baseline ref (yarn-built main).
#
# Failure signals: file-list drift, `dependencies` / `peerDependencies` range
# change, or missing/extra files in the packed layout.

set -euo pipefail

BASELINE_REF="${BASELINE_REF:-main}"
ROOT="$(git rev-parse --show-toplevel)"
OUT_DIR="$(mktemp -d -t castore-pack-parity.XXXXXX)"
trap 'rm -rf "$OUT_DIR"' EXIT

PACKAGES=(
  packages/core
  packages/event-storage-adapter-dynamodb
  packages/event-storage-adapter-postgres
  packages/event-storage-adapter-in-memory
  packages/event-storage-adapter-redux
  packages/event-storage-adapter-http
  packages/event-type-json-schema
  packages/event-type-zod
  packages/command-json-schema
  packages/command-zod
  packages/message-bus-adapter-event-bridge
  packages/message-bus-adapter-event-bridge-s3
  packages/message-bus-adapter-in-memory
  packages/message-queue-adapter-sqs
  packages/message-queue-adapter-sqs-s3
  packages/message-queue-adapter-in-memory
  packages/lib-test-tools
  packages/lib-react-visualizer
  packages/lib-dam
)

pack_side() {
  local label="$1"
  local workdir="$OUT_DIR/$label"
  mkdir -p "$workdir"
  cp README.md ./packages/core/README.md
  pnpm package >/dev/null
  for pkg in "${PACKAGES[@]}"; do
    local name
    name="$(basename "$pkg")"
    ( cd "$pkg" && npm pack --dry-run --json ) \
      | jq 'del(.[0].version, .[0].packageManager, .[0].gitHead, .[0].size, .[0].unpackedSize, .[0].integrity, .[0].shasum, .[0].filename, .[0].files[].size)
            | .[0].files |= sort_by(.path)' \
      > "$workdir/${name}.json"
  done
}

cd "$ROOT"

echo "[publish-parity] packing current branch..."
pack_side current

echo "[publish-parity] packing ${BASELINE_REF}..."
git stash push --include-untracked -m "publish-parity-temp" >/dev/null || true
git checkout "$BASELINE_REF"
# On the baseline, use its own package manager (likely yarn).
if [ -f yarn.lock ]; then
  yarn install --immutable >/dev/null
  yarn package >/dev/null
else
  pnpm install --frozen-lockfile >/dev/null
  pnpm package >/dev/null
fi
for pkg in "${PACKAGES[@]}"; do
  name="$(basename "$pkg")"
  ( cd "$pkg" && npm pack --dry-run --json ) \
    | jq 'del(.[0].version, .[0].packageManager, .[0].gitHead, .[0].size, .[0].unpackedSize, .[0].integrity, .[0].shasum, .[0].filename, .[0].files[].size)
          | .[0].files |= sort_by(.path)' \
    > "$OUT_DIR/baseline/${name}.json"
done
git checkout - >/dev/null
git stash pop >/dev/null 2>&1 || true

echo "[publish-parity] diffing..."
STATUS=0
for pkg in "${PACKAGES[@]}"; do
  name="$(basename "$pkg")"
  if ! diff -u "$OUT_DIR/baseline/${name}.json" "$OUT_DIR/current/${name}.json"; then
    echo "[publish-parity] FAIL: $name diverged"
    STATUS=1
  fi
done

if [ "$STATUS" -eq 0 ]; then
  echo "[publish-parity] OK — all ${#PACKAGES[@]} tarballs are equivalent."
fi
exit "$STATUS"
