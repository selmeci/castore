#!/usr/bin/env bash
# lockfile-drift-check.sh
#
# Detects drift between the committed pnpm-lock.yaml and what a fresh resolve
# would produce from the current package.json graph. Run in CI or locally
# after dependency edits to catch out-of-date lockfiles before they reach
# reviewers.
#
# Note: this is drift detection (committed vs re-resolved), not tamper
# detection — compromised upstream content would still match the hash.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ ! -f pnpm-lock.yaml ]; then
  echo "[lockfile-drift] FAIL: pnpm-lock.yaml missing"
  exit 1
fi

BACKUP="$(mktemp -t pnpm-lock.committed.XXXXXX.yaml)"
trap 'mv "$BACKUP" pnpm-lock.yaml' EXIT
cp pnpm-lock.yaml "$BACKUP"

echo "[lockfile-drift] running fresh resolve (no frozen-lockfile)..."
pnpm install --lockfile-only >/dev/null

if diff -q "$BACKUP" pnpm-lock.yaml >/dev/null; then
  echo "[lockfile-drift] OK — committed lockfile matches fresh resolve."
  exit 0
fi

echo "[lockfile-drift] FAIL — lockfile drift detected:"
diff -u "$BACKUP" pnpm-lock.yaml | head -80
exit 1
